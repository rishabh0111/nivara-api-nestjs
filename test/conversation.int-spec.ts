import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { asOwner, asOwnerArmed, contactOf, userOf } from './helpers/as-owner';
import { bootApp } from './helpers/boot';
import { seededTenantIds } from './helpers/seeded-tenants';

/**
 * Messages and Notes, end to end and against a real database.
 *
 * Two claims need a database rather than a unit test, and they are why this
 * file exists. The first is separation: a Note must not be reachable through
 * the customer-visible thread read, and the only convincing demonstration is to
 * write one and then fail to find it — through the endpoint, with the real
 * query, not against a mock that was told what to return. The second is
 * attribution: the author is stamped by a trigger from the armed context, so
 * proving it cannot be forged means reaching past the application entirely and
 * inserting a row that claims a different author.
 *
 * Requires `docker compose up -d postgres && npm run db:migrate && npm run
 * db:seed`; see `npm run test:int`.
 */

const PASSWORD = 'nivara-demo-password';

/** Stamped on every Ticket this suite writes, so cleanup can find them all. */
const MARK = 'conversation-int-spec';

describe('conversation', () => {
  let app: INestApplication;
  let meridian: string;
  let sortwood: string;
  let agentToken: string;
  let sortwoodToken: string;
  let contactId: string;
  let agentUserId: string;

  beforeAll(async () => {
    app = await bootApp();
    ({ meridian, sortwood } = await seededTenantIds());

    agentToken = await tokenFor(meridian, 'agent@meridian.test');
    sortwoodToken = await tokenFor(sortwood, 'admin@sortwood.test');

    contactId = await contactOf(meridian, 'jules@example.test');
    agentUserId = await userOf(meridian, 'agent@meridian.test');
  });

  afterAll(async () => {
    await app?.close();
    // Messages and Notes cascade with the Ticket they hang off, so deleting
    // the Tickets is the whole cleanup — which is itself a small check that
    // the cascade is really there.
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

  /** A Ticket to hang a conversation off, in Meridian unless told otherwise. */
  const openTicket = async (
    token = agentToken,
    requester = contactId,
  ): Promise<string> => {
    const { body } = await server()
      .post('/tickets')
      .set('Authorization', `Bearer ${token}`)
      .send({
        subject: `${MARK} ${randomUUID()}`,
        contactId: requester,
        source: 'portal',
      })
      .expect(201);

    return body.id as string;
  };

  const post = (token: string, path: string, body: object) =>
    server().post(path).set('Authorization', `Bearer ${token}`).send(body);

  const get = (token: string, path: string) =>
    server().get(path).set('Authorization', `Bearer ${token}`);

  describe('posting a Message', () => {
    it('records what was said and who said it', async () => {
      const ticketId = await openTicket();

      const { body } = await post(agentToken, `/tickets/${ticketId}/messages`, {
        body: 'We have shipped a replacement.',
      }).expect(201);

      expect(body).toEqual({
        id: expect.any(String),
        ticketId,
        body: 'We have shipped a replacement.',
        // Neither of these was in the request. They come from the credential
        // that made it, stamped by the trigger.
        authorKind: 'user',
        authorId: agentUserId,
        createdAt: expect.any(String),
      });
    });

    it('does not put the tenant on the wire', async () => {
      const ticketId = await openTicket();

      const { body } = await post(agentToken, `/tickets/${ticketId}/messages`, {
        body: 'Hello.',
      }).expect(201);

      expect(body).not.toHaveProperty('tenantId');
    });

    it('refuses an author chosen by the caller', async () => {
      const ticketId = await openTicket();

      await post(agentToken, `/tickets/${ticketId}/messages`, {
        body: 'Hello.',
        authorKind: 'contact',
        authorId: contactId,
      }).expect(422);
    });

    it('refuses an empty body', async () => {
      const ticketId = await openTicket();

      const response = await post(agentToken, `/tickets/${ticketId}/messages`, {
        body: '',
      }).expect(422);

      expect(response.body.error.code).toBe('validation_failed');
    });

    /**
     * The composite `(tenant_id, ticket_id)` foreign key is what makes this a
     * 404 rather than a 201: foreign keys are checked with row-level security
     * bypassed, so a plain reference would have accepted Sortwood's Ticket and
     * hung a Meridian Message off it (ADR-0002). The answer is identical to the
     * one a nonexistent Ticket gets, so this cannot be used to probe.
     */
    it('refuses another tenant’s Ticket as nonexistent, not as forbidden', async () => {
      const sortwoodTicketId = await openTicket(
        sortwoodToken,
        await contactOf(sortwood, 'sam@example.test'),
      );

      const response = await post(
        agentToken,
        `/tickets/${sortwoodTicketId}/messages`,
        { body: 'Wrong tenant.' },
      ).expect(404);

      expect(response.body.error.code).toBe('not_found');
    });

    it('refuses a Ticket that does not exist anywhere', async () => {
      await post(agentToken, `/tickets/${randomUUID()}/messages`, {
        body: 'Nowhere.',
      }).expect(404);
    });
  });

  describe('writing a Note', () => {
    it('records it, attributed like a Message', async () => {
      const ticketId = await openTicket();

      const { body } = await post(agentToken, `/tickets/${ticketId}/notes`, {
        body: 'Third time this customer has reported this.',
      }).expect(201);

      expect(body).toEqual({
        id: expect.any(String),
        ticketId,
        body: 'Third time this customer has reported this.',
        authorKind: 'user',
        authorId: agentUserId,
        createdAt: expect.any(String),
      });
    });

    it('is readable by staff on its own surface', async () => {
      const ticketId = await openTicket();

      await post(agentToken, `/tickets/${ticketId}/notes`, {
        body: 'Escalating to engineering.',
      }).expect(201);

      const { body } = await get(
        agentToken,
        `/tickets/${ticketId}/notes`,
      ).expect(200);

      expect(body.data).toHaveLength(1);
      expect(body.data[0].body).toBe('Escalating to engineering.');
    });
  });

  /**
   * The requirement the whole design exists to serve.
   *
   * Worth being clear about what these assertions can and cannot prove. They
   * cannot prove that *no* code path leaks a Note — that claim rests on the
   * schema, where a Note is a row in a table the customer-visible read does not
   * name, and no test enumerates code paths. What they do is catch the two ways
   * that could stop being true: the thread read learning to look at `note`, and
   * a `note` row somehow reaching the customer-visible endpoint at all.
   */
  describe('separation', () => {
    it('does not return Notes through the customer-visible thread', async () => {
      const ticketId = await openTicket();

      await post(agentToken, `/tickets/${ticketId}/messages`, {
        body: 'Sorry about the delay.',
      }).expect(201);

      await post(agentToken, `/tickets/${ticketId}/notes`, {
        body: 'Customer is furious, handle carefully.',
      }).expect(201);

      const { body } = await get(
        agentToken,
        `/tickets/${ticketId}/messages`,
      ).expect(200);

      expect(body.data).toHaveLength(1);
      expect(body.data[0].body).toBe('Sorry about the delay.');
      expect(JSON.stringify(body)).not.toContain('furious');
    });

    it('does not return Messages through the Notes surface', async () => {
      const ticketId = await openTicket();

      await post(agentToken, `/tickets/${ticketId}/messages`, {
        body: 'Sorry about the delay.',
      }).expect(201);

      const { body } = await get(
        agentToken,
        `/tickets/${ticketId}/notes`,
      ).expect(200);

      expect(body.data).toEqual([]);
    });

    /**
     * They are genuinely two tables, not one table read two ways. If a future
     * refactor collapsed them behind a discriminator this would still pass at
     * the endpoint level, which is exactly why the check is made here against
     * the schema instead.
     */
    it('keeps the two in separate tables', async () => {
      const ticketId = await openTicket();

      await post(agentToken, `/tickets/${ticketId}/notes`, {
        body: 'Internal only.',
      }).expect(201);

      const messages = await asOwner<{ count: string }>(
        'SELECT count(*)::text FROM message WHERE ticket_id = $1',
        [ticketId],
      );
      const notes = await asOwner<{ count: string }>(
        'SELECT count(*)::text FROM note WHERE ticket_id = $1',
        [ticketId],
      );

      expect(messages[0].count).toBe('0');
      expect(notes[0].count).toBe('1');
    });
  });

  describe('attribution', () => {
    /**
     * The claim the application's own path cannot test, because it never names
     * an author in the first place. Inserting directly as the owner — with the
     * context armed as the agent, and the row asserting a Contact wrote it —
     * is the only way to ask whether the trigger overrides a supplied author or
     * merely fills in a missing one. It must override: otherwise "who wrote
     * this" is whatever the writing code claimed, and a Message could be
     * attributed to the customer it was sent to.
     */
    it('stamps the author from the context, overriding what the insert claimed', async () => {
      const ticketId = await openTicket();

      const rows = await asOwnerArmed<{
        author_kind: string;
        author_id: string;
      }>(
        { tenantId: meridian, actorKind: 'user', actorId: agentUserId },
        `INSERT INTO message (id, tenant_id, ticket_id, body, author_kind, author_id)
         VALUES (gen_random_uuid(), $1, $2, 'Forged.', 'contact', $3)
         RETURNING author_kind::text, author_id::text`,
        [meridian, ticketId, contactId],
      );

      expect(rows[0]).toEqual({
        author_kind: 'user',
        author_id: agentUserId,
      });
    });

    /**
     * A Message written with no actor in context is refused outright rather
     * than landing as `system`. Attribution is what makes deflection — the
     * share of Messages a service token authored — a number worth computing,
     * and a population of unattributed rows quietly labelled `system` would
     * make it a fiction.
     */
    it('refuses an insert with no actor in context', async () => {
      const ticketId = await openTicket();

      await expect(
        asOwnerArmed(
          // A tenant, so the policy is satisfied and the refusal can only be
          // about the missing actor.
          { tenantId: meridian, actorKind: '' as 'user', actorId: '' },
          `INSERT INTO message (id, tenant_id, ticket_id, body)
           VALUES (gen_random_uuid(), $1, $2, 'Unattributed.')`,
          [meridian, ticketId],
        ),
      ).rejects.toThrow(/no actor in context/);
    });
  });

  describe('reading a thread', () => {
    it('404s a Ticket in another tenant rather than returning an empty page', async () => {
      const sortwoodTicketId = await openTicket(
        sortwoodToken,
        await contactOf(sortwood, 'sam@example.test'),
      );

      const response = await get(
        agentToken,
        `/tickets/${sortwoodTicketId}/messages`,
      ).expect(404);

      expect(response.body.error.code).toBe('not_found');
      await get(agentToken, `/tickets/${sortwoodTicketId}/notes`).expect(404);
    });

    it('returns newest first by default and oldest first on request', async () => {
      const ticketId = await openTicket();

      for (const body of ['first', 'second', 'third']) {
        await post(agentToken, `/tickets/${ticketId}/messages`, {
          body,
        }).expect(201);
      }

      const newest = await get(
        agentToken,
        `/tickets/${ticketId}/messages`,
      ).expect(200);

      expect(newest.body.data.map((m: { body: string }) => m.body)).toEqual([
        'third',
        'second',
        'first',
      ]);

      const oldest = await get(
        agentToken,
        `/tickets/${ticketId}/messages?sort=createdAt`,
      ).expect(200);

      expect(oldest.body.data.map((m: { body: string }) => m.body)).toEqual([
        'first',
        'second',
        'third',
      ]);
    });

    it('walks the whole thread through the cursor without repeating a row', async () => {
      const ticketId = await openTicket();
      const written = ['a', 'b', 'c', 'd', 'e'];

      for (const body of written) {
        await post(agentToken, `/tickets/${ticketId}/messages`, {
          body,
        }).expect(201);
      }

      const seen: string[] = [];
      let cursor: string | null = null;

      do {
        const query: string = cursor
          ? `?limit=2&sort=createdAt&cursor=${encodeURIComponent(cursor)}`
          : '?limit=2&sort=createdAt';

        const { body } = await get(
          agentToken,
          `/tickets/${ticketId}/messages${query}`,
        ).expect(200);

        seen.push(...body.data.map((m: { body: string }) => m.body));
        cursor = body.nextCursor as string | null;
      } while (cursor);

      expect(seen).toEqual(written);
    });

    it('refuses a sort field that is not on the allowlist', async () => {
      const ticketId = await openTicket();

      const response = await get(
        agentToken,
        `/tickets/${ticketId}/messages?sort=body`,
      ).expect(400);

      expect(response.body.error.code).toBe('invalid_sort');
    });

    it('refuses an unknown query parameter rather than ignoring it', async () => {
      const ticketId = await openTicket();

      const response = await get(
        agentToken,
        `/tickets/${ticketId}/messages?authorKind=user`,
      ).expect(400);

      expect(response.body.error.code).toBe('invalid_filter');
    });
  });

  describe('authentication', () => {
    it('refuses every conversation route without a credential', async () => {
      const ticketId = await openTicket();

      await server().get(`/tickets/${ticketId}/messages`).expect(401);
      await server().get(`/tickets/${ticketId}/notes`).expect(401);
      await server()
        .post(`/tickets/${ticketId}/messages`)
        .send({ body: 'Hello.' })
        .expect(401);
      await server()
        .post(`/tickets/${ticketId}/notes`)
        .send({ body: 'Hello.' })
        .expect(401);
    });
  });
});
