import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { asOwner, asOwnerArmed, contactOf, userOf } from './helpers/as-owner';
import { bootApp } from './helpers/boot';
import { seededTenantIds } from './helpers/seeded-tenants';

/**
 * The lifecycle, against a real database.
 *
 * The claim this ticket makes is not "the API rejects illegal transitions" — it
 * is "illegal transitions are impossible", and the difference is only visible
 * from outside the application. So the suite drives the machine twice: through
 * the API as the runtime role, and through a direct owner connection that holds
 * every privilege the application does not. A guarantee that survives only the
 * first is a convention; one that survives both is a schema fact, which is what
 * the Spring and FastAPI ports are going to inherit.
 *
 * The role dimension is the exception, and it is asserted here only at the
 * seam. Which roles may trigger what is decided in `src/tickets/state-machine.ts`
 * and exhausted in its unit spec; what this file checks is that the guard is
 * actually in the request path.
 *
 * Requires `docker compose up -d postgres && npm run db:migrate && npm run
 * db:seed`; see `npm run test:int`.
 */

const PASSWORD = 'nivara-demo-password';

/** Stamped on every Ticket this suite writes, so cleanup can find them all. */
const MARK = 'state-int-spec';

/** The active triad, which is meant to interconvert without restriction. */
const ACTIVE = ['open', 'pending', 'on_hold'] as const;

describe('the ticket state machine', () => {
  let app: INestApplication;
  let meridian: string;
  let agentToken: string;
  let adminToken: string;
  let contactId: string;
  let agentUserId: string;

  beforeAll(async () => {
    app = await bootApp();
    ({ meridian } = await seededTenantIds());

    agentToken = await tokenFor(meridian, 'agent@meridian.test');
    adminToken = await tokenFor(meridian, 'admin@meridian.test');

    contactId = await contactOf(meridian, 'jules@example.test');
    agentUserId = await userOf(meridian, 'agent@meridian.test');
  });

  afterAll(async () => {
    await app?.close();
    // Tickets only. Their audit rows are not deletable by anyone — that is the
    // point of that table — and the foreign key releases them as the Tickets go.
    await asOwner(`DELETE FROM ticket WHERE subject LIKE '${MARK}%'`, []);
  });

  const server = () => request(app.getHttpServer());

  const tokenFor = async (tenantId: string, email: string): Promise<string> => {
    const { body } = await server()
      .post('/auth/sign-in')
      .send({ tenantId, email, password: PASSWORD })
      .expect(200);

    return body.accessToken as string;
  };

  const createTicket = async (): Promise<string> => {
    const { body } = await server()
      .post('/tickets')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({
        subject: `${MARK} ${randomUUID()}`,
        contactId,
        source: 'portal',
      })
      .expect(201);

    return body.id as string;
  };

  const setState = (id: string, state: string, token = agentToken) =>
    server()
      .patch(`/tickets/${id}/state`)
      .set('Authorization', `Bearer ${token}`)
      .send({ state });

  const setPriority = (id: string, priority: string, token = agentToken) =>
    server()
      .patch(`/tickets/${id}/priority`)
      .set('Authorization', `Bearer ${token}`)
      .send({ priority });

  const setAssignee = (id: string, assigneeId: string | null) =>
    server()
      .patch(`/tickets/${id}/assignee`)
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ assigneeId });

  /** Walks a Ticket to a state, asserting each step is legal on the way. */
  const ticketIn = async (state: string): Promise<string> => {
    const id = await createTicket();

    if (state === 'open') return id;

    // `pending`, `on_hold` and `resolved` are all one step from birth; only
    // `closed` needs a second. Taking the shortest route matters because
    // several tests count the audit entries a Ticket has accumulated.
    if (state === 'closed') {
      await setState(id, 'resolved').expect(200);
      await setState(id, 'closed', adminToken).expect(200);

      return id;
    }

    await setState(id, state).expect(200);

    return id;
  };

  // -------------------------------------------------------------------------
  // The transition table
  // -------------------------------------------------------------------------

  describe('the legal moves', () => {
    /**
     * The three live states describe a situation rather than mark progress
     * through a workflow, so an agent should never have to route through a
     * third state to say what is true.
     */
    it('lets the active triad interconvert freely', async () => {
      for (const from of ACTIVE) {
        for (const to of ACTIVE) {
          if (from === to) continue;

          const id = await ticketIn(from);
          const { body } = await setState(id, to).expect(200);

          expect(body.state).toBe(to);
        }
      }
    });

    it('resolves from any active state', async () => {
      for (const from of ACTIVE) {
        const id = await ticketIn(from);
        const { body } = await setState(id, 'resolved').expect(200);

        expect(body.state).toBe('resolved');
      }
    });

    /**
     * Reopening is this transition and not a `reopened` state, which is what
     * keeps SLA, analytics and the queue filters from carrying a special case
     * for a near-duplicate of `open`.
     */
    it('reopens a resolved Ticket to open', async () => {
      const id = await ticketIn('resolved');
      const { body } = await setState(id, 'open').expect(200);

      expect(body.state).toBe('open');
    });

    it('closes a resolved Ticket, for an admin', async () => {
      const id = await ticketIn('resolved');
      const { body } = await setState(id, 'closed', adminToken).expect(200);

      expect(body.state).toBe('closed');
    });

    /**
     * A retried request must not fail where the first one succeeded, and a
     * no-op is not a transition — the trigger never sees it, because there is
     * nothing to check or to record.
     */
    it('accepts a move to the state the Ticket is already in', async () => {
      const id = await ticketIn('pending');
      const before = await transitionEntries(id);

      const { body } = await setState(id, 'pending').expect(200);

      expect(body.state).toBe('pending');
      // And it is genuinely a no-op rather than a transition onto itself: the
      // trigger never fires, so nothing is recorded.
      expect(await transitionEntries(id)).toHaveLength(before.length);
    });
  });

  describe('the illegal moves', () => {
    it('refuses a jump from an active state straight to closed', async () => {
      for (const from of ACTIVE) {
        const id = await ticketIn(from);

        // As an admin, so the refusal is the transition table's and not the
        // role guard's — an agent would be turned away one layer earlier.
        const response = await setState(id, 'closed', adminToken).expect(409);

        expect(response.body.error.code).toBe('conflict');
        expect(await stateOf(id)).toBe(from);
      }
    });

    /**
     * The property that makes `closed` terminal rather than merely final-ish.
     * A Contact who replies to a closed Ticket gets a new linked Ticket
     * (ticket 10) rather than this history revived.
     */
    it('refuses every move out of closed, including for an admin', async () => {
      const id = await ticketIn('closed');

      for (const to of [...ACTIVE, 'resolved']) {
        await setState(id, to, adminToken).expect(409);
      }

      expect(await stateOf(id)).toBe('closed');
    });

    it('refuses reopening from resolved to anything but open', async () => {
      for (const to of ['pending', 'on_hold']) {
        const id = await ticketIn('resolved');

        await setState(id, to, adminToken).expect(409);
        expect(await stateOf(id)).toBe('resolved');
      }
    });

    it('refuses a state outside the enum before the database is reached', async () => {
      const id = await createTicket();

      await setState(id, 'escalated').expect(422);
    });
  });

  // -------------------------------------------------------------------------
  // Enforcement below the application
  // -------------------------------------------------------------------------

  /**
   * The reason the transition table is SQL and not TypeScript.
   *
   * These bypass the API entirely, on the owner connection — the one credential
   * in the system that outranks every grant and every policy. If the invariant
   * held only for `TicketService`, each of these would succeed, and so would
   * the equivalent write from the Spring port, the scheduler, or a psql
   * session.
   */
  describe('enforcement below the application', () => {
    it('refuses an illegal transition written directly to the table', async () => {
      const id = await ticketIn('open');

      await expect(
        asOwner('UPDATE ticket SET state = $1 WHERE id = $2', ['closed', id]),
      ).rejects.toThrow(/not a legal transition/);

      expect(await stateOf(id)).toBe('open');
    });

    it('refuses a direct write out of closed', async () => {
      const id = await ticketIn('closed');

      await expect(
        asOwner('UPDATE ticket SET state = $1 WHERE id = $2', ['open', id]),
      ).rejects.toThrow(/not a legal transition/);
    });

    /**
     * Even a *legal* transition cannot be written from outside an armed
     * context: the trigger's audit insert reads the actor from the context
     * GUCs, and `audit_log` raises rather than recording an unattributed
     * change. Auditing is therefore not a thing a write path can decline to do
     * — it is a condition of the write succeeding at all.
     */
    it('refuses even a legal direct write when no actor is armed', async () => {
      const id = await ticketIn('open');

      await expect(
        asOwner('UPDATE ticket SET state = $1 WHERE id = $2', ['pending', id]),
      ).rejects.toThrow(/no actor in context/);

      expect(await stateOf(id)).toBe('open');
    });

    /**
     * And the other half of that claim: armed, the same statement goes through
     * and lands its entry. Without this the test above would be satisfied by a
     * trigger that refused everything.
     */
    it('accepts a legal direct write inside an armed context, and audits it', async () => {
      const id = await ticketIn('open');

      await asOwnerArmed(
        { tenantId: meridian, actorKind: 'user', actorId: agentUserId },
        'UPDATE ticket SET state = $1 WHERE id = $2',
        ['pending', id],
      );

      expect(await stateOf(id)).toBe('pending');
      expect((await transitionEntries(id))[0]).toMatchObject({
        actorKind: 'user',
        actorId: agentUserId,
        fromValue: 'open',
        toValue: 'pending',
      });
    });

    /**
     * The hole one statement earlier than the transition table.
     *
     * A Ticket inserted straight into a later state never entered the machine:
     * it skipped the transition table, skipped the permission that reserves
     * closing, and left no `ticket.transitioned` row saying it happened. The
     * column default is not enough on its own — a default only decides what
     * happens when nobody names a value, and a writer that names one is exactly
     * the case that matters.
     *
     * "Born open" is also what the rest of the design rests on: there is no
     * `new` state because untriaged is `assignee IS NULL`, and no `reopened`
     * state because reopening is a transition. Both assume every Ticket starts
     * from the same place.
     */
    it('refuses a Ticket inserted into any state but open', async () => {
      for (const state of ['pending', 'on_hold', 'resolved', 'closed']) {
        await expect(
          asOwner(
            `INSERT INTO ticket (id, tenant_id, subject, contact_id, source, state, updated_at)
             VALUES (gen_random_uuid(), $1, $2, $3, 'portal', $4, now())`,
            [meridian, `${MARK} born-${state}`, contactId, state],
          ),
        ).rejects.toThrow(/born open/);
      }
    });

    it('accepts one inserted as open, or with no state named at all', async () => {
      for (const columns of [
        'source, state, updated_at',
        'source, updated_at',
      ]) {
        const values =
          columns === 'source, state, updated_at'
            ? "'portal', 'open', now()"
            : "'portal', now()";

        const rows = await asOwner<{ state: string }>(
          `INSERT INTO ticket (id, tenant_id, subject, contact_id, ${columns})
           VALUES (gen_random_uuid(), $1, $2, $3, ${values}) RETURNING state`,
          [meridian, `${MARK} born-open`, contactId],
        );

        expect(rows[0].state).toBe('open');
      }
    });
  });

  // -------------------------------------------------------------------------
  // The role dimension
  // -------------------------------------------------------------------------

  describe('who may close', () => {
    /**
     * The one asymmetry between the roles, and the one part of the machine that
     * cannot live in SQL — the database does not see the credential.
     */
    it('refuses an agent closing a Ticket', async () => {
      const id = await ticketIn('resolved');

      const response = await setState(id, 'closed', agentToken).expect(403);

      expect(response.body.error.code).toBe('forbidden');
      expect(await stateOf(id)).toBe('resolved');
    });

    it('lets an agent do everything short of closing', async () => {
      const id = await ticketIn('open');

      for (const to of ['pending', 'on_hold', 'resolved', 'open']) {
        await setState(id, to, agentToken).expect(200);
      }
    });
  });

  // -------------------------------------------------------------------------
  // What a closed Ticket locks
  // -------------------------------------------------------------------------

  describe('a closed Ticket is locked', () => {
    /**
     * The one place the two axes touch. Priority is orthogonal to state
     * everywhere else — any urgency is valid in any state — but reprioritising
     * finished work asserts something false about a queue nobody is working.
     */
    it('refuses a priority change on a closed Ticket', async () => {
      const id = await ticketIn('closed');
      const before = await priorityOf(id);

      const response = await setPriority(id, 'urgent', adminToken).expect(409);

      expect(response.body.error.code).toBe('conflict');
      expect(await priorityOf(id)).toBe(before);
    });

    /**
     * Both columns, not just priority. Reprioritising finished work and handing
     * it to someone are the same false claim about a queue nobody is working,
     * and locking one while leaving the other open would be an arbitrary
     * half-rule.
     */
    it('refuses an assignee change on a closed Ticket', async () => {
      const id = await ticketIn('closed');

      const response = await setAssignee(id, agentUserId).expect(409);

      expect(response.body.error.code).toBe('conflict');
    });

    it('refuses both on a direct write too', async () => {
      const id = await ticketIn('closed');

      await expect(
        asOwner('UPDATE ticket SET priority = $1 WHERE id = $2', [
          'urgent',
          id,
        ]),
      ).rejects.toThrow(/a closed Ticket is locked/);

      await expect(
        asOwner('UPDATE ticket SET assignee_id = $1 WHERE id = $2', [
          agentUserId,
          id,
        ]),
      ).rejects.toThrow(/a closed Ticket is locked/);
    });

    /**
     * The subject is deliberately not locked: correcting a typo in a finished
     * record is not a claim about live work, so the rule is narrower than "a
     * closed row is frozen" and this is what says so.
     */
    it('still allows the subject to be corrected', async () => {
      const id = await ticketIn('closed');

      await asOwnerArmed(
        { tenantId: meridian, actorKind: 'user', actorId: agentUserId },
        'UPDATE ticket SET subject = $1 WHERE id = $2',
        [`${MARK} corrected`, id],
      );
    });

    it('allows a priority change in every other state', async () => {
      for (const state of [...ACTIVE, 'resolved']) {
        const id = await ticketIn(state);
        const { body } = await setPriority(id, 'urgent').expect(200);

        expect(body.priority).toBe('urgent');
        expect(body.state).toBe(state);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Auditing, from the trigger that enforces
  // -------------------------------------------------------------------------

  /**
   * The reason the audit insert lives in the trigger rather than in
   * `TicketService`: "was that change logged" stops being a question about the
   * call site. The statement that permits the change is the statement that
   * records it, so there is no write path that can do one without the other.
   */
  describe('what a transition records', () => {
    it('emits a ticket.transitioned entry naming both states', async () => {
      const id = await createTicket();

      await setState(id, 'pending').expect(200);

      const [entry] = await transitionEntries(id);

      expect(entry).toMatchObject({
        action: 'ticket.transitioned',
        targetKind: 'ticket',
        targetId: id,
        ticketId: id,
        fromValue: 'open',
        toValue: 'pending',
      });
    });

    /**
     * Attribution is not a parameter the trigger passes. It is stamped by
     * `audit_log`'s own insert trigger from the armed context, so the entry
     * names whoever's credential opened the transaction rather than whatever
     * the writing code claims about itself.
     */
    it('attributes the transition to the User who made it', async () => {
      const id = await ticketIn('resolved');

      await setState(id, 'closed', adminToken).expect(200);

      const adminUserId = await userOf(meridian, 'admin@meridian.test');
      const [latest] = await transitionEntries(id);

      expect(latest).toMatchObject({
        actorKind: 'user',
        actorId: adminUserId,
        fromValue: 'resolved',
        toValue: 'closed',
      });
    });

    it('records one entry per transition, in order', async () => {
      const id = await createTicket();

      await setState(id, 'pending').expect(200);
      await setState(id, 'on_hold').expect(200);
      await setState(id, 'resolved').expect(200);

      const pairs = (await transitionEntries(id))
        .reverse()
        .map((entry) => `${entry.fromValue}->${entry.toValue}`);

      expect(pairs).toEqual([
        'open->pending',
        'pending->on_hold',
        'on_hold->resolved',
      ]);
    });

    it('records nothing for a refused transition', async () => {
      const id = await ticketIn('open');

      await setState(id, 'closed', adminToken).expect(409);

      expect(await transitionEntries(id)).toHaveLength(0);
    });

    it('emits a ticket.assigned entry, including for an unassignment', async () => {
      const id = await createTicket();

      await setAssignee(id, agentUserId).expect(200);
      await setAssignee(id, null).expect(200);

      const entries = (await entriesFor(id, 'ticket.assigned')).reverse();

      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({
        fromValue: null,
        toValue: agentUserId,
      });
      // The `IS DISTINCT FROM` case, and the entry that answers "who dropped
      // this?" — under a plain `<>` comparison it would silently go missing.
      expect(entries[1]).toMatchObject({
        fromValue: agentUserId,
        toValue: null,
      });
    });

    it('emits a ticket.priority_changed entry', async () => {
      const id = await createTicket();

      await setPriority(id, 'urgent').expect(200);

      const [entry] = await entriesFor(id, 'ticket.priority_changed');

      expect(entry).toMatchObject({
        action: 'ticket.priority_changed',
        targetKind: 'ticket',
        targetId: id,
        fromValue: 'normal',
        toValue: 'urgent',
      });
    });

    /**
     * An edit that changes nothing is not an event. Without this the log would
     * fill with rows recording that somebody re-sent the value already there,
     * and a timeline that is mostly noise is one nobody reads.
     */
    it('records nothing when an edit changes no value', async () => {
      const id = await createTicket();

      await setPriority(id, 'normal').expect(200);
      await setAssignee(id, null).expect(200);

      const { body } = await server()
        .get(`/tickets/${id}/audit`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      // The creation entry, and nothing else.
      expect(body.data).toHaveLength(1);
      expect(body.data[0].action).toBe('ticket.created');
    });
  });

  // --- Reading the results -------------------------------------------------

  interface Entry {
    action: string;
    actorKind: string;
    actorId: string | null;
    targetKind: string;
    targetId: string;
    ticketId: string | null;
    fromValue: string | null;
    toValue: string | null;
  }

  /** One Ticket's timeline, newest first, filtered to one action. */
  const entriesFor = async (
    ticketId: string,
    action: string,
  ): Promise<Entry[]> => {
    const { body } = await server()
      .get(`/tickets/${ticketId}/audit?limit=100`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    return (body.data as Entry[]).filter((entry) => entry.action === action);
  };

  const transitionEntries = (ticketId: string): Promise<Entry[]> =>
    entriesFor(ticketId, 'ticket.transitioned');

  const stateOf = async (id: string): Promise<string> => {
    const { body } = await server()
      .get(`/tickets/${id}`)
      .set('Authorization', `Bearer ${agentToken}`)
      .expect(200);

    return body.state as string;
  };

  const priorityOf = async (id: string): Promise<string> => {
    const { body } = await server()
      .get(`/tickets/${id}`)
      .set('Authorization', `Bearer ${agentToken}`)
      .expect(200);

    return body.priority as string;
  };
});
