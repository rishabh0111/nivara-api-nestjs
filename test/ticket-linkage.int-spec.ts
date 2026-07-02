import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { asOwner, contactOf, userOf } from './helpers/as-owner';
import { bootApp } from './helpers/boot';
import { seededTenantIds } from './helpers/seeded-tenants';

/**
 * Reply-reopen, spawned Tickets, and the conversation chain.
 *
 * Almost nothing here can be asserted without a database, and that is the point
 * of the ticket rather than an inconvenience. The reopen depends on the
 * transition trigger permitting a move made by a principal holding no
 * permissions; the spawn depends on a trigger deriving `root_ticket_id` from a
 * parent the caller never names; the re-reply invariant depends on a unique
 * partial index over an expression. Each of those is a claim about Postgres, and
 * a mock told what to return would prove only that this file agrees with itself.
 *
 * The immutability tests reach past the application entirely, as the audit-log
 * suite does. A pointer that no code path writes is not immutable, it is merely
 * unwritten — and the difference only shows up against a connection that
 * outranks the API.
 *
 * Requires `docker compose up -d postgres && npm run db:migrate && npm run
 * db:seed`; see `npm run test:int`.
 */

const PASSWORD = 'nivara-demo-password';

/** Stamped on every Ticket this suite writes, so cleanup can find them all. */
const MARK = 'linkage-int-spec';

describe('ticket linkage', () => {
  let app: INestApplication;
  let meridian: string;

  /** Jules — a Meridian Contact with a portal credential. */
  let julesToken: string;
  let julesId: string;

  /** An admin, because only `ticket:close` reaches the terminal state. */
  let adminToken: string;
  let agentUserId: string;

  beforeAll(async () => {
    app = await bootApp();
    ({ meridian } = await seededTenantIds());

    julesId = await contactOf(meridian, 'jules@example.test');
    agentUserId = await userOf(meridian, 'agent@meridian.test');

    julesToken = await portalTokenFor(meridian, 'jules@example.test');
    adminToken = await staffTokenFor(meridian, 'admin@meridian.test');
  });

  afterAll(async () => {
    await app?.close();
    // Spawned Tickets inherit their parent's subject, so the mark reaches the
    // whole chain — and the self-referential cascade would have taken the
    // descendants anyway.
    await asOwner(`DELETE FROM ticket WHERE subject LIKE '${MARK}%'`, []);
  });

  const server = () => request(app.getHttpServer());

  const portalTokenFor = async (
    tenantId: string,
    email: string,
  ): Promise<string> => {
    const { body } = await server()
      .post('/portal/auth/sign-in')
      .send({ tenantId, email, password: PASSWORD })
      .expect(200);

    return body.accessToken as string;
  };

  const staffTokenFor = async (
    tenantId: string,
    email: string,
  ): Promise<string> => {
    const { body } = await server()
      .post('/auth/sign-in')
      .send({ tenantId, email, password: PASSWORD })
      .expect(200);

    return body.accessToken as string;
  };

  const get = (token: string, path: string) =>
    server().get(path).set('Authorization', `Bearer ${token}`);

  const post = (token: string, path: string, body: object) =>
    server().post(path).set('Authorization', `Bearer ${token}`).send(body);

  const patch = (token: string, path: string, body: object) =>
    server().patch(path).set('Authorization', `Bearer ${token}`).send(body);

  /** A Ticket Jules opened on the portal, born `open`. */
  const openTicket = async (): Promise<string> => {
    const { body } = await post(julesToken, '/portal/tickets', {
      subject: `${MARK} ${randomUUID()}`,
    }).expect(201);

    return body.id as string;
  };

  const moveTo = (id: string, state: string) =>
    patch(adminToken, `/tickets/${id}/state`, { state }).expect(200);

  /** Drives a Ticket all the way to the terminal state. */
  const closeTicket = async (id: string): Promise<void> => {
    await moveTo(id, 'resolved');
    await moveTo(id, 'closed');
  };

  const replyAsJules = (id: string, body: string) =>
    post(julesToken, `/portal/tickets/${id}/messages`, { body });

  const readTicket = async (id: string) =>
    (await get(adminToken, `/tickets/${id}`).expect(200)).body;

  /** The raw linkage columns, which the API deliberately does not put on the wire. */
  const linkageOf = async (id: string) => {
    const rows = await asOwner<{
      spawned_from: string | null;
      root: string | null;
    }>(
      `SELECT spawned_from_ticket_id::text AS spawned_from,
              root_ticket_id::text        AS root
         FROM ticket WHERE id = $1`,
      [id],
    );

    return rows[0];
  };

  describe('a reply to a live Ticket', () => {
    it('reopens one that was waiting on the customer', async () => {
      const id = await openTicket();
      await moveTo(id, 'pending');

      await replyAsJules(id, 'Here is the order number you asked for.').expect(
        201,
      );

      expect((await readTicket(id)).state).toBe('open');
    });

    it('reopens one the agent considered resolved', async () => {
      const id = await openTicket();
      await moveTo(id, 'resolved');

      await replyAsJules(id, 'This is still happening.').expect(201);

      expect((await readTicket(id)).state).toBe('open');
    });

    it('attributes the reopen to the Contact who caused it', async () => {
      const id = await openTicket();
      await moveTo(id, 'resolved');

      await replyAsJules(id, 'Still broken.').expect(201);

      const { body } = await get(adminToken, `/tickets/${id}/audit`).expect(
        200,
      );

      const reopen = body.data.find(
        (entry: { action: string; toValue: string }) =>
          entry.action === 'ticket.transitioned' && entry.toValue === 'open',
      );

      // Stamped by the trigger from the armed context, not claimed by the
      // request — a Contact holds no `ticket:transition` and still caused this.
      expect(reopen).toMatchObject({
        actorKind: 'contact',
        actorId: julesId,
        fromValue: 'resolved',
        toValue: 'open',
      });
    });

    it('leaves an already-open Ticket exactly where it is', async () => {
      const id = await openTicket();

      await replyAsJules(id, 'One more detail.').expect(201);

      expect((await readTicket(id)).state).toBe('open');
      expect(await linkageOf(id)).toEqual({ spawned_from: null, root: null });
    });
  });

  describe('a reply to a closed Ticket', () => {
    it('spawns a linked Ticket rather than reviving the closed one', async () => {
      const parent = await openTicket();
      await closeTicket(parent);

      const { body: message } = await replyAsJules(
        parent,
        'This came back a week later.',
      ).expect(201);

      // The Message did not land on the Ticket it was addressed to.
      expect(message.ticketId).not.toBe(parent);

      const spawned = await readTicket(message.ticketId);

      expect(spawned.state).toBe('open');
      expect(await linkageOf(spawned.id)).toEqual({
        spawned_from: parent,
        // The parent is the chain's origin, so the child's root is the parent
        // itself — derived by the trigger, never supplied by the API.
        root: parent,
      });

      // Linkage is purely additive: the parent is untouched and stays finished.
      expect((await readTicket(parent)).state).toBe('closed');
    });

    it('inherits the Contact and the linkage, and nothing else', async () => {
      const parent = await openTicket();

      // Triage the parent before closing it, so there is something stale to
      // wrongly carry forward. Both edits have to happen before `closed`, which
      // locks the record against exactly this pair.
      await moveTo(parent, 'resolved');
      await patch(adminToken, `/tickets/${parent}/priority`, {
        priority: 'urgent',
      }).expect(200);
      await patch(adminToken, `/tickets/${parent}/assignee`, {
        assigneeId: agentUserId,
      }).expect(200);
      await moveTo(parent, 'closed');

      const { body: message } = await replyAsJules(
        parent,
        'It is happening again.',
      ).expect(201);

      const spawned = await readTicket(message.ticketId);

      // The same person is still asking.
      expect(spawned.contactId).toBe(julesId);
      // A stale `urgent` would arm a breach on a brand-new SLA clock.
      expect(spawned.priority).toBe('normal');
      // A stale assignee would hand fresh work to whoever held the last
      // conversation, possibly weeks ago.
      expect(spawned.assigneeId).toBeNull();
      // Where the reply arrived, which is what keeps channel analytics honest.
      expect(spawned.source).toBe('portal');
    });

    it('makes the reply the spawned Ticket’s first Message', async () => {
      const parent = await openTicket();
      await closeTicket(parent);

      const { body: message } = await replyAsJules(
        parent,
        'Reopening this properly.',
      ).expect(201);

      const { body: thread } = await get(
        adminToken,
        `/tickets/${message.ticketId}/messages`,
      ).expect(200);

      // Not born empty: the first-response clock has a real anchor.
      expect(thread.data).toHaveLength(1);
      expect(thread.data[0]).toMatchObject({
        id: message.id,
        body: 'Reopening this properly.',
        authorKind: 'contact',
        authorId: julesId,
      });
    });

    it('carries the origin down a chain rather than re-rooting it', async () => {
      const origin = await openTicket();
      await closeTicket(origin);

      const { body: first } = await replyAsJules(
        origin,
        'Second round.',
      ).expect(201);
      await closeTicket(first.ticketId);

      const { body: second } = await replyAsJules(
        first.ticketId,
        'Third round.',
      ).expect(201);

      // The grandchild's parent is the child, but its root is still the origin —
      // which is what makes the whole conversation one flat lookup.
      expect(await linkageOf(second.ticketId)).toEqual({
        spawned_from: first.ticketId,
        root: origin,
      });
    });
  });

  describe('the re-reply invariant', () => {
    it('appends to the live Ticket instead of spawning a second one', async () => {
      const parent = await openTicket();
      await closeTicket(parent);

      const { body: first } = await replyAsJules(parent, 'First chase.').expect(
        201,
      );
      const { body: second } = await replyAsJules(
        parent,
        'Second chase.',
      ).expect(201);

      // Both replies landed on the same spawned Ticket. A chatty customer does
      // not fan out into duplicates in the queue.
      expect(second.ticketId).toBe(first.ticketId);

      const chain = await asOwner<{ count: string }>(
        `SELECT count(*)::text FROM ticket
          WHERE id = $1 OR root_ticket_id = $1`,
        [parent],
      );

      expect(chain[0].count).toBe('2');
    });

    it('reopens the live Ticket when appending to it', async () => {
      const parent = await openTicket();
      await closeTicket(parent);

      const { body: first } = await replyAsJules(parent, 'First chase.').expect(
        201,
      );
      // The agent works the spawned Ticket and parks it back on the customer.
      await moveTo(first.ticketId, 'pending');

      // The customer replies to the *closed* parent again, as a mail client
      // threading on the old conversation would. The reply appends to the live
      // Ticket — and must reopen it, exactly as it would have if the customer
      // had addressed that Ticket directly. Otherwise the dispute lands on a
      // Ticket nobody re-queues.
      const { body: second } = await replyAsJules(
        parent,
        'Here is what you asked for.',
      ).expect(201);

      expect(second.ticketId).toBe(first.ticketId);
      expect((await readTicket(first.ticketId)).state).toBe('open');
    });

    it('reopens a resolved live Ticket reached through its closed parent', async () => {
      const parent = await openTicket();
      await closeTicket(parent);

      const { body: first } = await replyAsJules(parent, 'First chase.').expect(
        201,
      );
      await moveTo(first.ticketId, 'resolved');

      const { body: second } = await replyAsJules(
        parent,
        'Still not right.',
      ).expect(201);

      expect(second.ticketId).toBe(first.ticketId);
      expect((await readTicket(first.ticketId)).state).toBe('open');
    });

    it('does not spawn a third Ticket in the process', async () => {
      const parent = await openTicket();
      await closeTicket(parent);

      const { body: first } = await replyAsJules(parent, 'First chase.').expect(
        201,
      );
      await moveTo(first.ticketId, 'pending');
      await replyAsJules(parent, 'Second chase.').expect(201);

      const chain = await asOwner<{ count: string }>(
        `SELECT count(*)::text FROM ticket
          WHERE id = $1 OR root_ticket_id = $1`,
        [parent],
      );

      expect(chain[0].count).toBe('2');
    });

    it('is enforced by the database, not only by the read before the write', async () => {
      const parent = await openTicket();
      await closeTicket(parent);

      const { body: spawned } = await replyAsJules(parent, 'A reply.').expect(
        201,
      );

      // A second live Ticket in the same chain, inserted as the owner — the
      // application would never attempt this, which is exactly why the attempt
      // has to be made from outside it.
      await expect(
        asOwner(
          // `updated_at` is spelled out because Prisma sets it client-side
          // rather than through a column default, so a raw writer must supply
          // it. Nothing to do with linkage; it is simply what an INSERT from
          // outside the ORM has to say.
          `INSERT INTO ticket (id, tenant_id, subject, contact_id, source, spawned_from_ticket_id, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, 'portal', $4, now())`,
          [meridian, `${MARK} duplicate`, julesId, parent],
        ),
      ).rejects.toThrow(/ticket_one_live_per_chain/);

      expect((await readTicket(spawned.ticketId)).state).toBe('open');
    });
  });

  describe('the conversation read', () => {
    it('returns the chain root-to-current in the standard envelope', async () => {
      const origin = await openTicket();
      await closeTicket(origin);

      const { body: child } = await replyAsJules(origin, 'Round two.').expect(
        201,
      );
      await closeTicket(child.ticketId);

      const { body: grandchild } = await replyAsJules(
        child.ticketId,
        'Round three.',
      ).expect(201);

      const { body } = await get(
        adminToken,
        `/tickets/${origin}/conversation`,
      ).expect(200);

      expect(body.data.map((t: { id: string }) => t.id)).toEqual([
        origin,
        child.ticketId,
        grandchild.ticketId,
      ]);
      // Bounded by how often a conversation has been finished and resumed, so
      // there is nothing to page through.
      expect(body.nextCursor).toBeNull();
    });

    it('answers the same chain from any Ticket in it', async () => {
      const origin = await openTicket();
      await closeTicket(origin);

      const { body: child } = await replyAsJules(origin, 'Round two.').expect(
        201,
      );

      const fromOrigin = await get(
        adminToken,
        `/tickets/${origin}/conversation`,
      ).expect(200);
      const fromChild = await get(
        adminToken,
        `/tickets/${child.ticketId}/conversation`,
      ).expect(200);

      expect(fromChild.body).toEqual(fromOrigin.body);
    });

    it('is a chain of one for a Ticket that has never been closed', async () => {
      const id = await openTicket();

      const { body } = await get(
        adminToken,
        `/tickets/${id}/conversation`,
      ).expect(200);

      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe(id);
    });

    it('answers 404 for a Ticket this principal cannot see', async () => {
      await get(adminToken, `/tickets/${randomUUID()}/conversation`).expect(
        404,
      );
    });
  });

  describe('immutability', () => {
    it('refuses to re-parent a Ticket', async () => {
      const parent = await openTicket();
      await closeTicket(parent);

      const { body: spawned } = await replyAsJules(parent, 'A reply.').expect(
        201,
      );
      const stranger = await openTicket();

      await expect(
        asOwner(`UPDATE ticket SET spawned_from_ticket_id = $1 WHERE id = $2`, [
          stranger,
          spawned.ticketId,
        ]),
      ).rejects.toThrow(/linkage is set at creation and immutable/);
    });

    it('refuses to rewrite a chain’s origin', async () => {
      const parent = await openTicket();
      await closeTicket(parent);

      const { body: spawned } = await replyAsJules(parent, 'A reply.').expect(
        201,
      );
      const stranger = await openTicket();

      await expect(
        asOwner(`UPDATE ticket SET root_ticket_id = $1 WHERE id = $2`, [
          stranger,
          spawned.ticketId,
        ]),
      ).rejects.toThrow(/linkage is set at creation and immutable/);
    });

    it('refuses to give an origin Ticket a parent after the fact', async () => {
      const origin = await openTicket();
      const other = await openTicket();

      await expect(
        asOwner(
          `UPDATE ticket SET spawned_from_ticket_id = $1, root_ticket_id = $1 WHERE id = $2`,
          [other, origin],
        ),
      ).rejects.toThrow(/linkage is set at creation and immutable/);
    });

    it('derives the root rather than believing a writer who names one', async () => {
      const parent = await openTicket();
      const decoy = await openTicket();
      await closeTicket(parent);

      // A root that disagrees with the parent, supplied at INSERT by the owner.
      // The trigger overwrites it: there is no reading under which a writer's
      // opinion about the root is worth having.
      const inserted = await asOwner<{ id: string }>(
        `INSERT INTO ticket (id, tenant_id, subject, contact_id, source, spawned_from_ticket_id, root_ticket_id, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'portal', $4, $5, now())
         RETURNING id::text`,
        [meridian, `${MARK} derived`, julesId, parent, decoy],
      );

      expect(await linkageOf(inserted[0].id)).toEqual({
        spawned_from: parent,
        root: parent,
      });
    });
  });
});
