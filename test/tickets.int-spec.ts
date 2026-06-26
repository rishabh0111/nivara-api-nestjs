import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Client, QueryResultRow } from 'pg';
import request from 'supertest';
import { bootApp } from './helpers/boot';
import { seededTenantIds } from './helpers/seeded-tenants';

/**
 * Running a queue, end to end and against a real database.
 *
 * The claims that need a database are the ones this file exists for: that the
 * tenant policy — not a `where` clause in the service — is what makes another
 * tenant's Ticket a 404, and that a keyset traversal stays stable while rows
 * are being inserted underneath it. The shapes of the seek predicate and the
 * filter allowlist are asserted directly in `src/common/pagination/keyset.spec.ts`
 * and `src/tickets/ticket-filters.spec.ts`; what is left here is whether they
 * are actually in the request path.
 *
 * Requires `docker compose up -d postgres && npm run db:migrate && npm run
 * db:seed`; see `npm run test:int`.
 */

const PASSWORD = 'nivara-demo-password';

/** Stamped on every Ticket this suite writes, so cleanup can find them all. */
const MARK = 'int-spec';

describe('tickets', () => {
  let app: INestApplication;
  let meridian: string;
  let sortwood: string;
  let agentToken: string;
  let adminToken: string;
  let sortwoodToken: string;
  let contactId: string;
  let sortwoodContactId: string;
  let agentUserId: string;

  beforeAll(async () => {
    app = await bootApp();
    ({ meridian, sortwood } = await seededTenantIds());

    agentToken = await tokenFor(meridian, 'agent@meridian.test');
    adminToken = await tokenFor(meridian, 'admin@meridian.test');
    sortwoodToken = await tokenFor(sortwood, 'admin@sortwood.test');

    contactId = await contactOf(meridian, 'jules@example.test');
    sortwoodContactId = await contactOf(sortwood, 'sam@example.test');
    agentUserId = await userOf(meridian, 'agent@meridian.test');
  });

  afterAll(async () => {
    await app?.close();
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

  /** A distinct subject per Ticket, so a filtered read finds only its own. */
  const subject = () => `${MARK} ${randomUUID()}`;

  const createTicket = (
    token: string,
    overrides: Record<string, unknown> = {},
  ) =>
    server()
      .post('/tickets')
      .set('Authorization', `Bearer ${token}`)
      .send({ subject: subject(), contactId, source: 'portal', ...overrides });

  const get = (token: string, path: string) =>
    server().get(path).set('Authorization', `Bearer ${token}`);

  describe('opening a Ticket', () => {
    it('is born open and normal, with the requester and source it was given', async () => {
      const { body } = await createTicket(agentToken, {
        source: 'widget',
      }).expect(201);

      expect(body).toEqual({
        id: expect.any(String),
        subject: expect.stringContaining(MARK),
        contactId,
        assigneeId: null,
        // The two defaults the ticket exists to guarantee. Neither is settable
        // at creation, so this is the only value either can have here.
        state: 'open',
        priority: 'normal',
        source: 'widget',
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
    });

    /**
     * `tenantId` is never on the wire — not as an input a caller could set,
     * and not as an output. It comes from the credential and stays there.
     */
    it('does not put the tenant on the wire', async () => {
      const { body } = await createTicket(agentToken).expect(201);

      expect(body).not.toHaveProperty('tenantId');
    });

    it('refuses a state or priority chosen by the caller', async () => {
      await createTicket(agentToken, { state: 'closed' }).expect(422);
      await createTicket(agentToken, { priority: 'urgent' }).expect(422);
    });

    it('refuses a Ticket with no requester', async () => {
      const response = await server()
        .post('/tickets')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ subject: subject(), source: 'portal' })
        .expect(422);

      expect(response.body.error.code).toBe('validation_failed');
    });

    /**
     * The regression this suite was written to catch, and it did: the first
     * version of the schema used a plain `contact_id -> contact(id)` foreign
     * key and this call returned 201. Postgres checks foreign keys with
     * row-level security bypassed, so the reference was satisfied by another
     * tenant's Contact and the cross-tenant link was really written.
     *
     * The composite `(tenant_id, contact_id)` key is what makes it a 404 now.
     * Deleting this test would let that come back silently.
     */
    it('refuses another tenant’s Contact as nonexistent, not as forbidden', async () => {
      const response = await createTicket(agentToken, {
        contactId: sortwoodContactId,
      }).expect(404);

      expect(response.body.error.code).toBe('not_found');
    });

    it('refuses a Contact that does not exist anywhere', async () => {
      await createTicket(agentToken, { contactId: randomUUID() }).expect(404);
    });
  });

  describe('reading one Ticket', () => {
    it('returns it bare, with no envelope', async () => {
      const created = await createTicket(agentToken).expect(201);
      const { body } = await get(
        agentToken,
        `/tickets/${created.body.id}`,
      ).expect(200);

      expect(body).toEqual(created.body);
      expect(body).not.toHaveProperty('data');
    });

    it('answers 404 for a Ticket that does not exist', async () => {
      await get(agentToken, `/tickets/${randomUUID()}`).expect(404);
    });

    /**
     * A malformed id is answered on shape rather than existence, and that is
     * not a crack in the 404 doctrine: no row's id can be a non-uuid, so this
     * reveals nothing about what exists. Unvalidated it was a 500 — Postgres
     * raises a type error on a bad `uuid` rather than failing to match.
     */
    it('answers 400 — not 500 — for an id that is not a uuid', async () => {
      const response = await get(agentToken, '/tickets/not-a-uuid').expect(400);

      expect(response.body.error.code).toBe('malformed_request');
    });

    it('answers 400 for a malformed id on every route that takes one', async () => {
      await server()
        .patch('/tickets/not-a-uuid/priority')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ priority: 'high' })
        .expect(400);

      await server()
        .patch('/tickets/not-a-uuid/assignee')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ assigneeId: null })
        .expect(400);
    });

    /**
     * The tenancy claim, and the reason it is 404 rather than 403: a 403 would
     * confirm the Ticket is real, which is a probe for the existence of
     * another tenant's data. The two answers are byte-identical.
     */
    it('answers 404 — never 403 — for another tenant’s Ticket', async () => {
      const theirs = await server()
        .post('/tickets')
        .set('Authorization', `Bearer ${sortwoodToken}`)
        .send({
          subject: subject(),
          contactId: sortwoodContactId,
          source: 'portal',
        })
        .expect(201);

      const foreign = await get(
        agentToken,
        `/tickets/${theirs.body.id}`,
      ).expect(404);
      const absent = await get(agentToken, `/tickets/${randomUUID()}`).expect(
        404,
      );

      expect(foreign.body).toEqual(absent.body);
    });
  });

  describe('listing Tickets', () => {
    it('wraps collections in the standard envelope', async () => {
      await createTicket(agentToken).expect(201);

      const { body } = await get(agentToken, '/tickets?limit=1').expect(200);

      expect(body).toEqual({
        data: [expect.objectContaining({ id: expect.any(String) })],
        nextCursor: expect.any(String),
      });
    });

    it('shows only this tenant’s Tickets', async () => {
      const { body } = await get(agentToken, '/tickets?limit=100').expect(200);

      const contacts = new Set(
        body.data.map((ticket: { contactId: string }) => ticket.contactId),
      );

      expect(contacts.has(sortwoodContactId)).toBe(false);
    });

    describe('the filter allowlist', () => {
      it('filters on an allowlisted field', async () => {
        const created = await createTicket(agentToken).expect(201);

        await server()
          .patch(`/tickets/${created.body.id}/priority`)
          .set('Authorization', `Bearer ${agentToken}`)
          .send({ priority: 'urgent' })
          .expect(200);

        const { body } = await get(
          agentToken,
          '/tickets?priority=urgent&limit=100',
        ).expect(200);

        expect(
          body.data.every(
            (ticket: { priority: string }) => ticket.priority === 'urgent',
          ),
        ).toBe(true);
        expect(
          body.data.some(
            (ticket: { id: string }) => ticket.id === created.body.id,
          ),
        ).toBe(true);
      });

      /**
       * The convention the whole kit turns on: unknown parameters are refused,
       * never ignored. A silently-dropped filter is a client bug that looks
       * like a server one, and it diverges across ports of this API.
       */
      it('rejects an unknown parameter rather than ignoring it', async () => {
        const response = await get(
          agentToken,
          '/tickets?assignee=someone',
        ).expect(400);

        expect(response.body.error.code).toBe('invalid_filter');
      });

      it('rejects a value outside a filter’s allowed set', async () => {
        const response = await get(
          agentToken,
          '/tickets?state=escalated',
        ).expect(400);

        expect(response.body.error.code).toBe('invalid_filter');
      });

      it('rejects a sort field that is not sortable', async () => {
        const response = await get(agentToken, '/tickets?sort=subject').expect(
          400,
        );

        expect(response.body.error.code).toBe('invalid_sort');
      });

      it('rejects a cursor issued under a different sort', async () => {
        const first = await get(agentToken, '/tickets?limit=1').expect(200);

        const response = await get(
          agentToken,
          `/tickets?limit=1&sort=createdAt&cursor=${encodeURIComponent(first.body.nextCursor)}`,
        ).expect(400);

        expect(response.body.error.code).toBe('invalid_cursor');
      });

      it('rejects a malformed cursor', async () => {
        await get(agentToken, '/tickets?cursor=not-a-cursor').expect(400);
      });

      /**
       * An id column is `uuid`, and Postgres raises a type error on a value
       * that is not one rather than failing to match. Unvalidated, these
       * reached the database and came back as 500s — a client typo reported as
       * a server fault.
       */
      it('rejects an id-shaped filter that is not a uuid', async () => {
        for (const query of [
          '/tickets?contactId=abc',
          '/tickets?assigneeId=abc',
        ]) {
          const response = await get(agentToken, query).expect(400);

          expect(response.body.error.code).toBe('invalid_filter');
        }
      });
    });

    describe('cursor traversal', () => {
      /**
       * The property offset pagination cannot hold, and the reason this API
       * uses a keyset at all.
       *
       * Tickets are a high-insert table: a row arriving while an agent pages
       * through the queue shifts every subsequent offset by one, so page two
       * repeats a row page one already showed. A cursor names a *position in
       * the ordering* rather than a count of rows skipped, so the insert is
       * invisible to a traversal already in flight.
       */
      it('is stable when rows are inserted mid-traversal', async () => {
        const contact = contactId;

        // A private corpus, so nothing else in the suite can perturb it.
        const marker = randomUUID();
        const created: string[] = [];

        for (let i = 0; i < 5; i++) {
          const { body } = await server()
            .post('/tickets')
            .set('Authorization', `Bearer ${agentToken}`)
            .send({
              subject: `${MARK} ${marker} ${i}`,
              contactId: contact,
              source: 'portal',
            })
            .expect(201);

          created.push(body.id);
        }

        const seen: string[] = [];
        let cursor: string | null = null;

        // Page one.
        const first = await get(
          agentToken,
          `/tickets?limit=2&contactId=${contact}`,
        ).expect(200);

        seen.push(...first.body.data.map((t: { id: string }) => t.id));
        cursor = first.body.nextCursor;

        // The insert that would break an offset traversal: newest-first, so it
        // lands ahead of everything already seen and shifts every offset by
        // one.
        await createTicket(agentToken).expect(201);

        // The rest of the traversal, on cursors alone.
        while (cursor !== null && seen.length < 12) {
          const next = await get(
            agentToken,
            `/tickets?limit=2&contactId=${contact}&cursor=${encodeURIComponent(cursor)}`,
          ).expect(200);

          seen.push(...next.body.data.map((t: { id: string }) => t.id));
          cursor = next.body.nextCursor;
        }

        // No row appears twice — the claim offset pagination fails.
        expect(new Set(seen).size).toBe(seen.length);

        // And nothing that existed before the traversal began was skipped.
        for (const id of created) expect(seen).toContain(id);
      });

      it('ends with a null cursor rather than an empty page', async () => {
        let cursor: string | null = null;
        let pages = 0;

        do {
          const query: string = cursor
            ? `/tickets?limit=100&cursor=${encodeURIComponent(cursor)}`
            : '/tickets?limit=100';

          const { body } = await get(agentToken, query).expect(200);

          cursor = body.nextCursor;
          pages++;
        } while (cursor !== null && pages < 20);

        expect(cursor).toBeNull();
      });
    });
  });

  describe('priority', () => {
    it('is settable independently of state', async () => {
      const { body: ticket } = await createTicket(agentToken).expect(201);

      for (const priority of ['low', 'high', 'urgent', 'normal']) {
        const { body } = await server()
          .patch(`/tickets/${ticket.id}/priority`)
          .set('Authorization', `Bearer ${agentToken}`)
          .send({ priority })
          .expect(200);

        expect(body.priority).toBe(priority);
        // The orthogonality claim: urgency moved, progress did not.
        expect(body.state).toBe('open');
      }
    });

    it('refuses a priority outside the enum', async () => {
      const { body: ticket } = await createTicket(agentToken).expect(201);

      await server()
        .patch(`/tickets/${ticket.id}/priority`)
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ priority: 'critical' })
        .expect(422);
    });

    it('answers 404 for another tenant’s Ticket', async () => {
      const theirs = await server()
        .post('/tickets')
        .set('Authorization', `Bearer ${sortwoodToken}`)
        .send({
          subject: subject(),
          contactId: sortwoodContactId,
          source: 'portal',
        })
        .expect(201);

      await server()
        .patch(`/tickets/${theirs.body.id}/priority`)
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ priority: 'urgent' })
        .expect(404);
    });
  });

  describe('assignment', () => {
    const assign = (ticketId: string, assigneeId: string | null) =>
      server()
        .patch(`/tickets/${ticketId}/assignee`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ assigneeId });

    it('moves a Ticket to one User and back to nobody', async () => {
      const { body: ticket } = await createTicket(agentToken).expect(201);

      expect(ticket.assigneeId).toBeNull();

      const assigned = await assign(ticket.id, agentUserId).expect(200);
      expect(assigned.body.assigneeId).toBe(agentUserId);

      const cleared = await assign(ticket.id, null).expect(200);
      expect(cleared.body.assigneeId).toBeNull();
    });

    /**
     * An omitted key is not the same request as an explicit `null`. One is a
     * body that expresses no assignment at all; the other is the deliberate
     * act of clearing one.
     */
    it('refuses a body that names no assignee at all', async () => {
      const { body: ticket } = await createTicket(agentToken).expect(201);

      await server()
        .patch(`/tickets/${ticket.id}/assignee`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({})
        .expect(422);
    });

    it('refuses a User from another tenant as nonexistent', async () => {
      const { body: ticket } = await createTicket(agentToken).expect(201);
      const theirUser = await userOf(sortwood, 'admin@sortwood.test');

      await assign(ticket.id, theirUser).expect(404);
    });

    it('finds unassigned Tickets through the triage filter', async () => {
      const { body: ticket } = await createTicket(agentToken).expect(201);

      const untriaged = await get(
        agentToken,
        '/tickets?assigneeId=none&limit=100',
      ).expect(200);

      expect(
        untriaged.body.data.every(
          (t: { assigneeId: string | null }) => t.assigneeId === null,
        ),
      ).toBe(true);
      expect(
        untriaged.body.data.some((t: { id: string }) => t.id === ticket.id),
      ).toBe(true);

      await assign(ticket.id, agentUserId).expect(200);

      const stillUntriaged = await get(
        agentToken,
        '/tickets?assigneeId=none&limit=100',
      ).expect(200);

      expect(
        stillUntriaged.body.data.some(
          (t: { id: string }) => t.id === ticket.id,
        ),
      ).toBe(false);
    });
  });

  /**
   * The isolation claim asserted where it actually lives, rather than through
   * an endpoint that a `where` clause could fake.
   */
  describe('how Tickets are isolated', () => {
    it('has row-level security enabled and forced on the table', async () => {
      const rows = await asOwner<{
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'ticket'",
        [],
      );

      expect(rows[0]).toEqual({
        relrowsecurity: true,
        relforcerowsecurity: true,
      });
    });

    it('carries a tenant-isolation policy', async () => {
      const rows = await asOwner<{ polname: string }>(
        "SELECT polname FROM pg_policy WHERE polrelid = 'ticket'::regclass",
        [],
      );

      expect(rows.map((row) => row.polname)).toContain('tenant_isolation');
    });
  });
});

/**
 * Reads seeded ids as the owner.
 *
 * The application cannot do this and should not be able to: resolving a
 * Contact id requires a tenant context, and the test needs ids from two
 * tenants at once precisely to show that neither can reach the other's.
 */
async function contactOf(tenantId: string, email: string): Promise<string> {
  return idOf('contact', tenantId, email);
}

async function userOf(tenantId: string, email: string): Promise<string> {
  return idOf('"user"', tenantId, email);
}

async function idOf(
  table: string,
  tenantId: string,
  email: string,
): Promise<string> {
  const rows = await asOwner<{ id: string }>(
    `SELECT id::text FROM ${table} WHERE tenant_id = $1 AND email = $2`,
    [tenantId, email],
  );

  if (rows.length === 0) {
    throw new Error(
      `Seeded ${table} ${email} is missing from tenant ${tenantId}. Run \`npm run db:seed\`.`,
    );
  }

  return rows[0].id;
}

/** A query from outside the policy system, as the owner. */
async function asOwner<T extends QueryResultRow>(
  sql: string,
  params: unknown[],
): Promise<T[]> {
  const client = new Client({
    connectionString: process.env['MIGRATE_DATABASE_URL'],
  });

  await client.connect();

  try {
    const { rows } = await client.query<T>(sql, params);
    return rows;
  } finally {
    await client.end();
  }
}
