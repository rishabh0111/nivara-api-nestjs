import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { asOwner, asOwnerArmed, contactOf, userOf } from './helpers/as-owner';
import { bootApp } from './helpers/boot';
import { seededTenantIds } from './helpers/seeded-tenants';

/**
 * The append-only history, against a real database.
 *
 * Almost every claim this ticket makes is a claim about Postgres rather than
 * about TypeScript — history cannot be rewritten, a row cannot exist without an
 * attributed actor, an entry outlives the Ticket it describes. None of those can
 * be demonstrated against a mock, and a mock that appeared to demonstrate them
 * would be asserting the test's own beliefs about SQL. So the guarantees are
 * exercised where they live: as the runtime role through the API, and as the
 * owner through a direct connection, because a guarantee that only holds for
 * the application is not tamper-evidence.
 *
 * Requires `docker compose up -d postgres && npm run db:migrate && npm run
 * db:seed`; see `npm run test:int`.
 */

const PASSWORD = 'nivara-demo-password';

/** Stamped on every Ticket this suite writes, so cleanup can find them all. */
const MARK = 'audit-int-spec';

describe('the audit log', () => {
  let app: INestApplication;
  let meridian: string;
  let sortwood: string;
  let agentToken: string;
  let adminToken: string;
  let sortwoodToken: string;
  let contactId: string;
  let sortwoodContactId: string;

  beforeAll(async () => {
    app = await bootApp();
    ({ meridian, sortwood } = await seededTenantIds());

    agentToken = await tokenFor(meridian, 'agent@meridian.test');
    adminToken = await tokenFor(meridian, 'admin@meridian.test');
    sortwoodToken = await tokenFor(sortwood, 'admin@sortwood.test');

    contactId = await contactOf(meridian, 'jules@example.test');
    sortwoodContactId = await contactOf(sortwood, 'sam@example.test');
  });

  afterAll(async () => {
    await app?.close();
    // Tickets only. The audit rows they produced are not deletable by anyone,
    // which is the point of the table — they stay, and cost nothing.
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

  const subject = () => `${MARK} ${randomUUID()}`;

  const createTicket = async (
    token = agentToken,
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string; state: string }> => {
    const { body } = await server()
      .post('/tickets')
      .set('Authorization', `Bearer ${token}`)
      .send({ subject: subject(), contactId, source: 'portal', ...overrides })
      .expect(201);

    return body;
  };

  const timeline = (ticketId: string, token = adminToken) =>
    server()
      .get(`/tickets/${ticketId}/audit`)
      .set('Authorization', `Bearer ${token}`);

  describe('what it records', () => {
    it('lands a ticket.created entry when a Ticket is opened', async () => {
      const ticket = await createTicket();

      const { body } = await timeline(ticket.id).expect(200);

      expect(body.data).toHaveLength(1);
      expect(body.data[0]).toMatchObject({
        action: 'ticket.created',
        targetKind: 'ticket',
        targetId: ticket.id,
        ticketId: ticket.id,
        fromValue: null,
        // Where the Ticket entered the state machine — the control-plane fact
        // about a creation.
        toValue: 'open',
      });
    });

    /**
     * The attribution claim. The actor is not a parameter any call site passes:
     * it is read from the context `withTenant()` armed, which came from the
     * access token. An entry naming the wrong person is therefore not a bug
     * that a forgotten argument can cause.
     */
    it('attributes the entry to the User whose credential opened the Ticket', async () => {
      const agentId = await userOf(meridian, 'agent@meridian.test');
      const ticket = await createTicket(agentToken);

      const { body } = await timeline(ticket.id).expect(200);

      expect(body.data[0]).toMatchObject({
        actorKind: 'user',
        actorId: agentId,
      });
    });

    /**
     * Conversation is domain data, attributed on its own rows. Duplicating it
     * here would drown the control-plane signal the log exists to carry — and
     * would quietly turn an admin-only endpoint into a way to read every
     * customer's messages.
     */
    it('exposes no field that conversation content could arrive in', async () => {
      const ticket = await createTicket();

      const { body } = await timeline(ticket.id).expect(200);

      expect(Object.keys(body.data[0]).sort()).toEqual([
        'action',
        'actorId',
        'actorKind',
        'correlationId',
        'createdAt',
        'fromValue',
        'id',
        'metadata',
        'targetId',
        'targetKind',
        'ticketId',
        'toValue',
      ]);
    });

    it('is a closed catalog of eight actions, with contact.merged reserved', async () => {
      const rows = await asOwner<{ label: string }>(
        'SELECT unnest(enum_range(NULL::audit_action))::text AS label',
        [],
      );

      expect(rows.map((row) => row.label).sort()).toEqual([
        'integration.failed',
        'sla.breached',
        'ticket.assigned',
        'ticket.created',
        'ticket.priority_changed',
        'ticket.transitioned',
        'token.minted',
        'token.revoked',
      ]);
    });
  });

  describe('reading a timeline', () => {
    it('wraps entries in the standard list envelope', async () => {
      const ticket = await createTicket();

      const { body } = await timeline(ticket.id).expect(200);

      expect(body).toEqual({
        data: expect.any(Array),
        nextCursor: null,
      });
    });

    /**
     * Admin-only, and the reason is that history answers a different question
     * than the queue does. An agent works Tickets; reconstructing who changed
     * what is supervision, and `audit:read` is not in the agent grant.
     */
    it('refuses an agent, who may work the Ticket but not audit it', async () => {
      const ticket = await createTicket();

      await timeline(ticket.id, agentToken).expect(403);
      await timeline(ticket.id, adminToken).expect(200);
    });

    /**
     * 404 rather than an empty page, and that is not pedantry: an empty page
     * asserts "this Ticket has no history", which is a statement about a Ticket
     * the caller must not learn exists.
     */
    it('answers 404 — never an empty page — for another tenant’s Ticket', async () => {
      const { body: theirs } = await server()
        .post('/tickets')
        .set('Authorization', `Bearer ${sortwoodToken}`)
        .send({
          subject: subject(),
          contactId: sortwoodContactId,
          source: 'portal',
        })
        .expect(201);

      const foreign = await timeline(theirs.id).expect(404);
      const absent = await timeline(randomUUID()).expect(404);

      expect(foreign.body).toEqual(absent.body);
    });

    it('answers 400 for an id that is not a uuid', async () => {
      const response = await timeline('not-a-uuid').expect(400);

      expect(response.body.error.code).toBe('malformed_request');
    });

    it('rejects an unknown query parameter rather than ignoring it', async () => {
      const ticket = await createTicket();

      const response = await server()
        .get(`/tickets/${ticket.id}/audit?action=ticket.created`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);

      expect(response.body.error.code).toBe('invalid_filter');
    });

    it('shows only this tenant’s history', async () => {
      const ticket = await createTicket();

      // Sortwood's admin holds `audit:read` in their own tenant, which is
      // exactly what makes this a real test of isolation rather than of
      // authorization.
      await timeline(ticket.id, sortwoodToken).expect(404);
    });
  });

  /**
   * The tamper-evidence claims, asserted where they are enforced.
   *
   * These run as the *owner* as well as through the API. A log the application
   * cannot rewrite but the migration role can is not append-only, it is merely
   * inconvenient to edit.
   */
  describe('how it is append-only', () => {
    it('withholds UPDATE and DELETE from the runtime role', async () => {
      const rows = await asOwner<{ privilege_type: string }>(
        `SELECT privilege_type FROM information_schema.table_privileges
         WHERE table_name = 'audit_log' AND grantee = 'app_user'`,
        [],
      );

      const granted = rows.map((row) => row.privilege_type).sort();

      expect(granted).toEqual(['INSERT', 'SELECT']);
      expect(granted).not.toContain('UPDATE');
      expect(granted).not.toContain('DELETE');
    });

    it('refuses an UPDATE from the owner, who cannot be denied by a grant', async () => {
      await expect(
        asOwner("UPDATE audit_log SET to_value = 'tampered'", []),
      ).rejects.toThrow(/append-only/);
    });

    /**
     * Statement-level, so a `DELETE` matching no rows is still an error. Under
     * row-level security a tampering attempt could otherwise report zero rows
     * affected and look like success.
     */
    it('refuses a DELETE from the owner, even one that would match nothing', async () => {
      await expect(asOwner('DELETE FROM audit_log', [])).rejects.toThrow(
        /append-only/,
      );

      await expect(
        asOwner('DELETE FROM audit_log WHERE id = $1', [randomUUID()]),
      ).rejects.toThrow(/append-only/);
    });

    /**
     * TRUNCATE is a separate event from DELETE, and a `BEFORE DELETE` trigger
     * does not see it. Withholding the privilege is not enough either — the
     * owner holds it inherently. Without its own trigger the entire log is one
     * statement away from gone, which is the most destructive thing that could
     * happen to it and the easiest to overlook.
     */
    it('refuses a TRUNCATE from the owner, which no DELETE trigger would catch', async () => {
      await expect(asOwner('TRUNCATE audit_log', [])).rejects.toThrow(
        /append-only/,
      );
    });

    /**
     * The `SET NULL` exemption is for the foreign key and nobody else.
     *
     * Detaching entries from their subject one at a time is quiet,
     * plausible-looking tampering — the entry survives, so nothing looks
     * deleted, but the timeline it belonged to is now silently short. The
     * trigger tells the two apart by nesting depth: the referential action
     * arrives inside `ticket`'s internal trigger, and a hand-written statement
     * does not.
     */
    it('refuses a hand-written statement that only nulls ticket_id', async () => {
      const ticket = await createTicket();

      await expect(
        asOwner('UPDATE audit_log SET ticket_id = NULL WHERE ticket_id = $1', [
          ticket.id,
        ]),
      ).rejects.toThrow(/append-only/);

      // And the entry is still attached, so the refusal was a refusal rather
      // than a rollback of half the work.
      const rows = await asOwner<{ ticket_id: string | null }>(
        'SELECT ticket_id FROM audit_log WHERE target_id = $1',
        [ticket.id],
      );

      expect(rows[0].ticket_id).toBe(ticket.id);
    });

    /**
     * The fail-closed actor rule. A write reaching this table outside an armed
     * context is precisely the unattributed mutation the log exists to catch,
     * so it raises rather than defaulting to `system` — defaulting would launder
     * it as legitimate.
     */
    it('refuses an INSERT with no actor in context', async () => {
      const ticket = await createTicket();

      await expect(
        asOwner(
          `INSERT INTO audit_log (id, tenant_id, action, target_kind, target_id, ticket_id)
           VALUES (gen_random_uuid(), $1, 'ticket.created', 'ticket', $2, $2)`,
          [meridian, ticket.id],
        ),
      ).rejects.toThrow(/no actor in context/);
    });

    /**
     * `system` is a claim some code makes on purpose. This is the other half of
     * the rule above: absence is an error, and the explicit value is accepted —
     * so the two cases can never be confused for one another.
     */
    it('accepts system as an actor only when it is set explicitly', async () => {
      const ticket = await createTicket();

      const rows = await asOwnerArmed<{
        actor_kind: string;
        actor_id: string | null;
      }>(
        { tenantId: meridian, actorKind: 'system' },
        `INSERT INTO audit_log (id, tenant_id, action, target_kind, target_id, ticket_id)
           VALUES (gen_random_uuid(), $1, 'sla.breached', 'ticket', $2, $2)
           RETURNING actor_kind, actor_id`,
        [meridian, ticket.id],
      );

      expect(rows[0]).toEqual({ actor_kind: 'system', actor_id: null });
    });

    /**
     * Attribution is a fact about who armed the transaction, not a claim the
     * inserting statement gets to make about itself. A supplied actor is
     * overwritten rather than trusted, so a forged one is not merely
     * discouraged.
     */
    it('overwrites an actor the inserting statement tried to supply', async () => {
      const ticket = await createTicket();
      const agentId = await userOf(meridian, 'agent@meridian.test');
      const adminId = await userOf(meridian, 'admin@meridian.test');

      const rows = await asOwnerArmed<{ actor_id: string }>(
        { tenantId: meridian, actorKind: 'user', actorId: agentId },
        `INSERT INTO audit_log (id, tenant_id, action, actor_kind, actor_id, target_kind, target_id, ticket_id)
           VALUES (gen_random_uuid(), $1, 'ticket.assigned', 'user', $3, 'ticket', $2, $2)
           RETURNING actor_id`,
        [meridian, ticket.id, adminId],
      );

      expect(rows[0].actor_id).toBe(agentId);
    });
  });

  /**
   * History outlives its subject. `ON DELETE SET NULL (ticket_id)` — the column
   * list Postgres 15 added — is what lets the reference be composite, and so
   * un-spoofable across tenants, *and* releasable when the Ticket goes.
   */
  describe('when the Ticket it describes is deleted', () => {
    it('keeps the entry, nulls the Ticket reference, and keeps the target', async () => {
      const ticket = await createTicket();

      const before = await asOwner<{ id: string }>(
        'SELECT id FROM audit_log WHERE target_id = $1',
        [ticket.id],
      );
      expect(before).toHaveLength(1);

      await asOwner('DELETE FROM ticket WHERE id = $1', [ticket.id]);

      const after = await asOwner<{
        ticket_id: string | null;
        target_id: string;
        action: string;
      }>(
        'SELECT ticket_id, target_id, action FROM audit_log WHERE target_id = $1',
        [ticket.id],
      );

      expect(after).toHaveLength(1);
      // The reference is released...
      expect(after[0].ticket_id).toBeNull();
      // ...but what the entry is *about* is not, so the record still says which
      // Ticket was created and by whom.
      expect(after[0].target_id).toBe(ticket.id);
      expect(after[0].action).toBe('ticket.created');
    });

    /**
     * The honest consequence of keeping history forever, and the reason this
     * one reference does not cascade from `tenant` the way every other
     * tenant-scoped table does. A cascade is a DELETE, and DELETE here is
     * refused — so the two would be opposite instructions, and Postgres would
     * report the conflict as an append-only error raised from a statement about
     * a different table entirely. `RESTRICT` says the actual rule, in an error
     * that names it.
     */
    it('refuses to let a Tenant with history be hard-deleted, naming the constraint', async () => {
      await createTicket();

      await expect(
        asOwner('DELETE FROM tenant WHERE id = $1', [meridian]),
      ).rejects.toThrow(/violates foreign key constraint/);
    });

    it('refuses an entry pointing at another tenant’s Ticket', async () => {
      const { body: theirs } = await server()
        .post('/tickets')
        .set('Authorization', `Bearer ${sortwoodToken}`)
        .send({
          subject: subject(),
          contactId: sortwoodContactId,
          source: 'portal',
        })
        .expect(201);

      // The composite key is what refuses this. A plain `ticket_id` reference
      // would accept it, because foreign keys are checked with row-level
      // security bypassed (ADR-0002).
      await expect(
        asOwnerArmed(
          { tenantId: meridian, actorKind: 'system' },
          `INSERT INTO audit_log (id, tenant_id, action, target_kind, target_id, ticket_id)
             VALUES (gen_random_uuid(), $1, 'ticket.created', 'ticket', $2, $2)`,
          [meridian, theirs.id],
        ),
      ).rejects.toThrow(/foreign key constraint/);
    });
  });

  describe('how entries are isolated', () => {
    it('has row-level security enabled and forced on the table', async () => {
      const rows = await asOwner<{
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'audit_log'",
        [],
      );

      expect(rows[0]).toEqual({
        relrowsecurity: true,
        relforcerowsecurity: true,
      });
    });

    it('carries a tenant-isolation policy', async () => {
      const rows = await asOwner<{ polname: string }>(
        "SELECT polname FROM pg_policy WHERE polrelid = 'audit_log'::regclass",
        [],
      );

      expect(rows.map((row) => row.polname)).toContain('tenant_isolation');
    });
  });
});
