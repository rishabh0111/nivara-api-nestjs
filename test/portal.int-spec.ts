import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { TenancyService, TenantClient } from 'src/tenancy/tenancy.service';
import { asOwner, contactOf, userOf } from './helpers/as-owner';
import { bootApp } from './helpers/boot';
import { seededTenantIds } from './helpers/seeded-tenants';

/**
 * The Contact principal and the portal surface, end to end.
 *
 * The claims this file exists for cannot be made against a mock, because what
 * they assert is that a *second access axis* holds — and an axis is only real if
 * the thing beneath it enforces it. So the interesting tests here do not merely
 * drive the portal endpoints and check the responses; several of them reach past
 * the application entirely, arm a Contact's context by hand, and ask Postgres
 * directly whether it will hand over rows the API declines to serve. A portal
 * that filters correctly on top of a database that would answer anyway is one
 * refactor away from leaking, and only the direct query can tell the two apart.
 *
 * Requires `docker compose up -d postgres && npm run db:migrate && npm run
 * db:seed`; see `npm run test:int`.
 */

const PASSWORD = 'nivara-demo-password';

/** Stamped on every Ticket this suite writes, so cleanup can find them all. */
const MARK = 'portal-int-spec';

describe('the portal', () => {
  let app: INestApplication;
  let meridian: string;
  let sortwood: string;

  /** Jules — a Meridian Contact with a portal credential. */
  let julesToken: string;
  let julesId: string;

  /** Sam — Sortwood's Contact, for the cross-tenant claims. */
  let samToken: string;
  let samId: string;

  let agentToken: string;
  let agentUserId: string;

  beforeAll(async () => {
    app = await bootApp();
    ({ meridian, sortwood } = await seededTenantIds());

    julesId = await contactOf(meridian, 'jules@example.test');
    samId = await contactOf(sortwood, 'sam@example.test');
    agentUserId = await userOf(meridian, 'agent@meridian.test');

    julesToken = await portalTokenFor(meridian, 'jules@example.test');
    samToken = await portalTokenFor(sortwood, 'sam@example.test');
    agentToken = await staffTokenFor(meridian, 'agent@meridian.test');
  });

  afterAll(async () => {
    await app?.close();
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

  /**
   * A query under an armed context, as the application's own runtime role.
   *
   * Deliberately *not* `asOwnerArmed` from the shared helpers, and the
   * distinction is the whole value of these tests. That helper connects as the
   * database owner, which is right for what it is used for elsewhere — proving
   * a trigger overrides what an insert claimed, reading two tenants' ids at
   * once — because those are questions about behaviour the policies do not
   * govern.
   *
   * Row-level security is a different matter: the owner is not subject to it in
   * the way `app_user` is, so every assertion below would pass against an owner
   * connection while proving nothing at all. Going through `TenancyService` is
   * what makes these tests about the policy rather than about the query.
   */
  const armedAs = <T>(
    actor: { kind: 'contact'; id: string } | { kind: 'user'; id: string },
    work: (tx: TenantClient) => Promise<T>,
  ): Promise<T> =>
    app.get(TenancyService).withTenant({ tenantId: meridian, actor }, work);

  const asContact = <T>(work: (tx: TenantClient) => Promise<T>): Promise<T> =>
    armedAs({ kind: 'contact', id: julesId }, work);

  const asStaff = <T>(work: (tx: TenantClient) => Promise<T>): Promise<T> =>
    armedAs({ kind: 'user', id: agentUserId }, work);

  const post = (token: string, path: string, body: object = {}) =>
    server().post(path).set('Authorization', `Bearer ${token}`).send(body);

  /** A Ticket opened through the portal by the given Contact. */
  const openViaPortal = async (token = julesToken): Promise<string> => {
    const { body } = await post(token, '/portal/tickets', {
      subject: `${MARK} ${randomUUID()}`,
    }).expect(201);

    return body.id as string;
  };

  /** A Ticket an agent opened on a Contact's behalf. */
  const openViaStaff = async (requester = julesId): Promise<string> => {
    const { body } = await post(agentToken, '/tickets', {
      subject: `${MARK} ${randomUUID()}`,
      contactId: requester,
      source: 'portal',
    }).expect(201);

    return body.id as string;
  };

  // -------------------------------------------------------------------------
  // "A Contact authenticates and is resolved into the uniform RequestPrincipal
  //  shape on its own axis"
  // -------------------------------------------------------------------------

  describe('authenticating', () => {
    it('signs a Contact in and describes it back on the contact axis', async () => {
      const { body } = await get(julesToken, '/portal/auth/me').expect(200);

      expect(body).toEqual({
        kind: 'contact',
        contactId: julesId,
        tenantId: meridian,
        email: 'jules@example.test',
        name: 'Jules Ferrand',
        verified: true,
      });

      // The shape a Contact principal must *not* have. A role here would mean
      // the customer axis had been folded back into the staff one.
      expect(body).not.toHaveProperty('role');
      expect(body).not.toHaveProperty('userId');
    });

    /**
     * The attribute no server-side test notices by accident.
     *
     * `Path` is a scoping rule a *browser* applies before it decides to send a
     * cookie; supertest's `.set('Cookie', ...)` ignores it entirely. So every
     * rotation test below would pass just as happily against a cookie scoped to
     * a path the portal does not live under — and the real client would simply
     * never send it, leaving portal sessions to die at fifteen minutes with no
     * refresh and no error to explain why. That is exactly what this code did
     * before review caught it, which is why the assertion is spelled out here
     * rather than folded into the rotation test.
     *
     * The distinct *name* is asserted for a quieter reason: a browser keys a
     * cookie by name and path, so two surfaces sharing a name would have the
     * later sign-in evict the earlier session — a staff console silently logged
     * out by opening the portal in another tab.
     */
    it('scopes its cookie to the portal’s own path and name', async () => {
      const signIn = await server()
        .post('/portal/auth/sign-in')
        .send({
          tenantId: meridian,
          email: 'jules@example.test',
          password: PASSWORD,
        })
        .expect(200);

      const header = signIn.headers['set-cookie'] as unknown as string[];
      const cookie = header.find((line) =>
        line.startsWith('nivara_portal_refresh='),
      );

      expect(cookie).toBeDefined();
      expect(cookie).toContain('Path=/portal/auth');
      expect(cookie).toContain('HttpOnly');

      // And it is not the staff cookie wearing a different value.
      expect(header.some((line) => line.startsWith('nivara_refresh='))).toBe(
        false,
      );
    });

    it('leaves a staff session intact when a Contact signs in', async () => {
      const staff = await server()
        .post('/auth/sign-in')
        .send({
          tenantId: meridian,
          email: 'agent@meridian.test',
          password: PASSWORD,
        })
        .expect(200);

      const staffCookie = staff.headers['set-cookie'] as unknown as string[];

      const portal = await server()
        .post('/portal/auth/sign-in')
        .send({
          tenantId: meridian,
          email: 'jules@example.test',
          password: PASSWORD,
        })
        .expect(200);

      const portalCookie = portal.headers['set-cookie'] as unknown as string[];

      // Both cookies can sit in one jar, so neither eviction happened.
      await server()
        .post('/auth/refresh')
        .set('Cookie', staffCookie)
        .expect(200);

      await server()
        .post('/portal/auth/refresh')
        .set('Cookie', portalCookie)
        .expect(200);
    });

    it('sets a refresh cookie and rotates it into a fresh session', async () => {
      const signIn = await server()
        .post('/portal/auth/sign-in')
        .send({
          tenantId: meridian,
          email: 'jules@example.test',
          password: PASSWORD,
        })
        .expect(200);

      const cookie = signIn.headers['set-cookie'];
      expect(cookie).toBeDefined();

      const refreshed = await server()
        .post('/portal/auth/refresh')
        .set('Cookie', cookie)
        .expect(200);

      expect(refreshed.body.accessToken).toEqual(expect.any(String));

      // Asserted on the *refresh* cookie rather than the access token, because
      // rotation is a claim about the refresh token and only incidentally about
      // its companion. Two access tokens minted in the same second for the same
      // principal are byte-identical — `iat` and `exp` have one-second
      // resolution — so comparing those would be a test of clock granularity.
      expect(refreshed.headers['set-cookie']).not.toEqual(cookie);

      // The rotated session works, which is the whole point of a portal session
      // outliving the fifteen minutes an access token is good for.
      await get(refreshed.body.accessToken as string, '/portal/auth/me').expect(
        200,
      );

      // And the spent token is dead: presenting it again is replay, which
      // evicts the family rather than issuing another pair.
      await server()
        .post('/portal/auth/refresh')
        .set('Cookie', cookie)
        .expect(401);
    });

    /**
     * The common case, and the one a portal must not leak. A Contact created
     * from a widget visit has no `passwordHash` at all — the seed's emailless
     * Meridian Contact is exactly that — and it must be refused identically to a
     * wrong password rather than with anything that says "no credential set".
     */
    it('refuses a Contact that has no portal credential', async () => {
      const response = await server()
        .post('/portal/auth/sign-in')
        .send({
          tenantId: meridian,
          email: 'nobody@example.test',
          password: PASSWORD,
        })
        .expect(401);

      expect(response.body.error.code).toBe('unauthenticated');
    });

    it('refuses a Contact of another tenant indistinguishably', async () => {
      // Jules is a Meridian Contact; asking Sortwood for them must fail exactly
      // as an unknown address does.
      const response = await server()
        .post('/portal/auth/sign-in')
        .send({
          tenantId: sortwood,
          email: 'jules@example.test',
          password: PASSWORD,
        })
        .expect(401);

      expect(response.body.error.code).toBe('unauthenticated');
    });

    /**
     * The two sign-ins resolve different tables. A staff address at the portal
     * and a Contact address at the staff door both fail — neither surface is a
     * fallback for the other.
     */
    it('keeps the two sign-in surfaces on their own tables', async () => {
      await server()
        .post('/portal/auth/sign-in')
        .send({
          tenantId: meridian,
          email: 'agent@meridian.test',
          password: PASSWORD,
        })
        .expect(401);

      await server()
        .post('/auth/sign-in')
        .send({
          tenantId: meridian,
          email: 'jules@example.test',
          password: PASSWORD,
        })
        .expect(401);
    });

    /**
     * One ledger serves both axes, so each refresh endpoint has to say which
     * axis it is. A portal token at the staff endpoint is refused, and — the
     * part worth asserting — refused *without* destroying the family, since a
     * client bug is not theft. The session still works afterwards.
     */
    it('refuses a portal refresh token at the staff endpoint without evicting it', async () => {
      const signIn = await server()
        .post('/portal/auth/sign-in')
        .send({
          tenantId: meridian,
          email: 'jules@example.test',
          password: PASSWORD,
        })
        .expect(200);

      const cookie = signIn.headers['set-cookie'];

      await server().post('/auth/refresh').set('Cookie', cookie).expect(401);

      // Still a live portal session: the wrong-door attempt cost nothing.
      await server()
        .post('/portal/auth/refresh')
        .set('Cookie', cookie)
        .expect(200);
    });

    it('refuses a staff refresh token at the portal endpoint', async () => {
      const signIn = await server()
        .post('/auth/sign-in')
        .send({
          tenantId: meridian,
          email: 'agent@meridian.test',
          password: PASSWORD,
        })
        .expect(200);

      await server()
        .post('/portal/auth/refresh')
        .set('Cookie', signIn.headers['set-cookie'])
        .expect(401);
    });
  });

  // -------------------------------------------------------------------------
  // "A Contact opens a ticket, which is born `open` with Source `portal`"
  // -------------------------------------------------------------------------

  describe('opening a Ticket', () => {
    it('is born open, normal and portal-sourced, requested by the caller', async () => {
      const { body } = await post(julesToken, '/portal/tickets', {
        subject: `${MARK} my order never arrived`,
      }).expect(201);

      expect(body).toMatchObject({
        subject: `${MARK} my order never arrived`,
        contactId: julesId,
        assigneeId: null,
        state: 'open',
        priority: 'normal',
        source: 'portal',
      });
    });

    /**
     * The requester is not a field of the request, so this is really a test
     * that the extra key is *rejected* rather than quietly honoured. The API's
     * unknown-property rule turns it into a 422 — which matters more here than
     * elsewhere, because the ignored-field version of this bug would file a
     * Ticket in another customer's name and look like it worked.
     */
    it('refuses a requester chosen by the caller', async () => {
      await post(julesToken, '/portal/tickets', {
        subject: `${MARK} not mine`,
        contactId: samId,
      }).expect(422);
    });

    it('refuses a source or priority chosen by the caller', async () => {
      await post(julesToken, '/portal/tickets', {
        subject: `${MARK} urgent please`,
        priority: 'urgent',
      }).expect(422);

      await post(julesToken, '/portal/tickets', {
        subject: `${MARK} from slack, honest`,
        source: 'slack',
      }).expect(422);
    });

    it('refuses an empty subject', async () => {
      const response = await post(julesToken, '/portal/tickets', {
        subject: '',
      }).expect(422);

      expect(response.body.error.code).toBe('validation_failed');
    });

    /**
     * Opening a Ticket is a control-plane act, and the audit row records who
     * did it. `contact` as an actor kind is what makes the trail honest about
     * customer-initiated work — the same column that will later distinguish a
     * human agent's action from the AI layer's.
     */
    it('audits the creation attributed to the Contact', async () => {
      const ticketId = await openViaPortal();

      const rows = await asOwner<{ actor_kind: string; actor_id: string }>(
        `SELECT actor_kind::text, actor_id::text FROM audit_log
         WHERE ticket_id = $1 AND action = 'ticket.created'`,
        [ticketId],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0]).toEqual({ actor_kind: 'contact', actor_id: julesId });
    });
  });

  // -------------------------------------------------------------------------
  // "A Contact lists and reads only their own tickets"
  // -------------------------------------------------------------------------

  describe('reading my own Tickets', () => {
    it('lists mine and not another Contact’s in the same tenant', async () => {
      const mine = await openViaPortal();

      // A second Meridian Contact, with a Ticket of their own. Created through
      // the staff surface because the anonymous seeded Contact cannot sign in.
      const otherContactId = await meridianAnonymousContact();
      const theirs = await openViaStaff(otherContactId);

      const { body } = await get(
        julesToken,
        '/portal/tickets?limit=100',
      ).expect(200);

      const ids = body.data.map((t: { id: string }) => t.id);

      expect(ids).toContain(mine);
      expect(ids).not.toContain(theirs);

      // Every row on the page is Jules's — not merely "theirs is missing".
      for (const ticket of body.data) {
        expect(ticket.contactId).toBe(julesId);
      }
    });

    it('reads my own Ticket', async () => {
      const ticketId = await openViaPortal();

      const { body } = await get(
        julesToken,
        `/portal/tickets/${ticketId}`,
      ).expect(200);

      expect(body.id).toBe(ticketId);
    });

    it('404s another Contact’s Ticket in my own tenant', async () => {
      const otherContactId = await meridianAnonymousContact();
      const theirs = await openViaStaff(otherContactId);

      const response = await get(
        julesToken,
        `/portal/tickets/${theirs}`,
      ).expect(404);

      expect(response.body.error.code).toBe('not_found');
    });

    it('404s a Ticket that does not exist anywhere', async () => {
      await get(julesToken, `/portal/tickets/${randomUUID()}`).expect(404);
    });

    /**
     * The explicit checklist item: another tenant's Ticket is 404, not 403.
     * A 403 would confirm the Ticket is real, which is a fact about another
     * tenant's customer that no answer here should carry.
     */
    it('404s another tenant’s Ticket rather than forbidding it', async () => {
      const sortwoodTicket = await openViaPortal(samToken);

      const response = await get(
        julesToken,
        `/portal/tickets/${sortwoodTicket}`,
      ).expect(404);

      expect(response.body.error.code).toBe('not_found');
      expect(response.status).not.toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // "A Contact reads the full customer-visible thread" /
  // "posts a Message attributed with authorKind contact"
  // -------------------------------------------------------------------------

  describe('the conversation on my Ticket', () => {
    it('posts a Message attributed to the Contact', async () => {
      const ticketId = await openViaPortal();

      const { body } = await post(
        julesToken,
        `/portal/tickets/${ticketId}/messages`,
        { body: 'Any update on this?' },
      ).expect(201);

      expect(body).toEqual({
        id: expect.any(String),
        ticketId,
        body: 'Any update on this?',
        // Neither was in the request: both are stamped from the credential.
        authorKind: 'contact',
        authorId: julesId,
        createdAt: expect.any(String),
      });
    });

    it('reads the whole customer-visible thread, both sides of it', async () => {
      const ticketId = await openViaPortal();

      await post(julesToken, `/portal/tickets/${ticketId}/messages`, {
        body: 'My order never arrived.',
      }).expect(201);

      await post(agentToken, `/tickets/${ticketId}/messages`, {
        body: 'We have shipped a replacement.',
      }).expect(201);

      const { body } = await get(
        julesToken,
        `/portal/tickets/${ticketId}/messages?sort=createdAt`,
      ).expect(200);

      expect(body.data.map((m: { body: string }) => m.body)).toEqual([
        'My order never arrived.',
        'We have shipped a replacement.',
      ]);

      // The agent's reply is attributed to the agent, and the Contact can see
      // that it was a person at the tenant who answered.
      expect(body.data[1]).toMatchObject({
        authorKind: 'user',
        authorId: agentUserId,
      });
    });

    it('refuses to post on another Contact’s Ticket', async () => {
      const otherContactId = await meridianAnonymousContact();
      const theirs = await openViaStaff(otherContactId);

      await post(julesToken, `/portal/tickets/${theirs}/messages`, {
        body: 'Butting in.',
      }).expect(404);
    });

    it('refuses to read another Contact’s thread', async () => {
      const otherContactId = await meridianAnonymousContact();
      const theirs = await openViaStaff(otherContactId);

      await post(agentToken, `/tickets/${theirs}/messages`, {
        body: 'Private to them.',
      }).expect(201);

      const response = await get(
        julesToken,
        `/portal/tickets/${theirs}/messages`,
      ).expect(404);

      expect(JSON.stringify(response.body)).not.toContain('Private to them');
    });

    it('refuses to post on another tenant’s Ticket', async () => {
      const sortwoodTicket = await openViaPortal(samToken);

      await post(julesToken, `/portal/tickets/${sortwoodTicket}/messages`, {
        body: 'Wrong tenant.',
      }).expect(404);
    });
  });

  // -------------------------------------------------------------------------
  // "A Contact cannot reach a Note through any endpoint"
  // -------------------------------------------------------------------------

  /**
   * Three independent refusals, asserted separately because they fail
   * separately. The point is not that a Note is hidden — it is that hiding one
   * takes no code, because there is nowhere for a Contact to ask.
   */
  describe('Notes are unreachable', () => {
    it('does not return a Note in the portal thread', async () => {
      const ticketId = await openViaPortal();

      await post(agentToken, `/tickets/${ticketId}/messages`, {
        body: 'Looking into it.',
      }).expect(201);

      await post(agentToken, `/tickets/${ticketId}/notes`, {
        body: 'Customer is furious, handle carefully.',
      }).expect(201);

      const { body } = await get(
        julesToken,
        `/portal/tickets/${ticketId}/messages`,
      ).expect(200);

      expect(body.data).toHaveLength(1);
      expect(body.data[0].body).toBe('Looking into it.');
      expect(JSON.stringify(body)).not.toContain('furious');
    });

    it('refuses the staff Notes endpoint to a Contact', async () => {
      const ticketId = await openViaPortal();

      await post(agentToken, `/tickets/${ticketId}/notes`, {
        body: 'Internal only.',
      }).expect(201);

      // 403 rather than 404: the refusal is about authority, and the Ticket is
      // one this Contact can legitimately see. It holds no `note:read`.
      const response = await get(
        julesToken,
        `/tickets/${ticketId}/notes`,
      ).expect(403);

      expect(response.body.error.code).toBe('forbidden');
      await post(julesToken, `/tickets/${ticketId}/notes`, {
        body: 'Writing my own.',
      }).expect(403);
    });

    /**
     * The claim that does not depend on any endpoint existing or not existing.
     * Armed as the Contact, straight at the database, asking for the Notes on a
     * Ticket that is genuinely theirs: the policy returns nothing. If every
     * portal handler were deleted tomorrow and replaced by a careless one, this
     * would still hold — and it holds for the Spring and FastAPI ports too.
     */
    it('returns no Note rows to a Contact’s own database context', async () => {
      const ticketId = await openViaPortal();

      await post(agentToken, `/tickets/${ticketId}/notes`, {
        body: 'Structurally invisible.',
      }).expect(201);

      // The Note really is there — read as the owner, outside the policies.
      const ownerRows = await asOwner<{ count: string }>(
        'SELECT count(*)::text FROM note WHERE ticket_id = $1',
        [ticketId],
      );
      expect(ownerRows[0].count).toBe('1');

      // And invisible from inside the Contact's own armed context, on a Ticket
      // that is genuinely theirs.
      await expect(
        asContact((tx) => tx.note.findMany({ where: { ticketId } })),
      ).resolves.toEqual([]);

      // While staff, in the same tenant, see it — so the policy is narrowing by
      // actor kind rather than the row simply being unreadable to everyone.
      const staffNotes = await asStaff((tx) =>
        tx.note.findMany({ where: { ticketId } }),
      );
      expect(staffNotes).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // "A Contact cannot perform any staff operation"
  // -------------------------------------------------------------------------

  describe('the staff surface is closed to a Contact', () => {
    it('refuses every staff ticket operation', async () => {
      const ticketId = await openViaPortal();

      await get(julesToken, '/tickets').expect(403);
      await get(julesToken, `/tickets/${ticketId}`).expect(403);
      await post(julesToken, '/tickets', {
        subject: `${MARK} as staff`,
        contactId: julesId,
        source: 'portal',
      }).expect(403);

      for (const [path, body] of [
        [`/tickets/${ticketId}/state`, { state: 'closed' }],
        [`/tickets/${ticketId}/priority`, { priority: 'urgent' }],
        [`/tickets/${ticketId}/assignee`, { assigneeId: agentUserId }],
      ] as const) {
        await server()
          .patch(path)
          .set('Authorization', `Bearer ${julesToken}`)
          .send(body)
          .expect(403);
      }
    });

    it('refuses tenant configuration and the audit log', async () => {
      const ticketId = await openViaPortal();

      await post(julesToken, '/staff/invitations', {
        email: 'intruder@meridian.test',
        name: 'Intruder',
        role: 'admin',
      }).expect(403);

      // The audit trail for a Ticket that is genuinely the Contact's own, so
      // the refusal is unambiguously about authority rather than visibility.
      await get(julesToken, `/tickets/${ticketId}/audit`).expect(403);
    });

    it('refuses the staff identity endpoint', async () => {
      const response = await get(julesToken, '/auth/me').expect(403);

      expect(response.body.error.code).toBe('forbidden');
    });

    /** And the inverse: staff are not portal users with fewer rows. */
    it('refuses staff at the portal surface', async () => {
      await get(agentToken, '/portal/tickets').expect(403);
      await get(agentToken, '/portal/auth/me').expect(403);
      await post(agentToken, '/portal/tickets', {
        subject: `${MARK} agent in the portal`,
      }).expect(403);
    });
  });

  // -------------------------------------------------------------------------
  // The axis, below the application
  // -------------------------------------------------------------------------

  /**
   * The application could be replaced wholesale and these would still hold.
   * That is what "enforced on a separate axis, RLS-backed" has to mean for a
   * design that will be ported twice.
   */
  describe('row-level security enforces the axis itself', () => {
    it('shows a Contact only its own Tickets, straight from the database', async () => {
      const mine = await openViaPortal();
      const otherContactId = await meridianAnonymousContact();
      const theirs = await openViaStaff(otherContactId);

      const visible = await asContact((tx) =>
        tx.ticket.findMany({
          where: { id: { in: [mine, theirs] } },
          select: { id: true },
        }),
      );

      expect(visible.map((row) => row.id)).toEqual([mine]);
    });

    it('shows a Contact only the Messages on its own Tickets', async () => {
      const otherContactId = await meridianAnonymousContact();
      const theirs = await openViaStaff(otherContactId);

      await post(agentToken, `/tickets/${theirs}/messages`, {
        body: 'Not for Jules.',
      }).expect(201);

      const visible = await asContact((tx) =>
        tx.message.findMany({ where: { ticketId: theirs } }),
      );

      expect(visible).toEqual([]);
    });

    /**
     * `WITH CHECK`, not just `USING`. Without it a Contact's context could
     * *write* a Ticket naming another requester even though it could not read
     * it back — which is precisely the "file a ticket in someone else's name"
     * failure the portal DTO also refuses, enforced where a DTO cannot reach.
     */
    it('refuses a Contact writing a Ticket for someone else', async () => {
      const otherContactId = await meridianAnonymousContact();

      await expect(
        asContact((tx) =>
          tx.ticket.create({
            data: {
              tenantId: meridian,
              subject: `${MARK} forged`,
              contactId: otherContactId,
              source: 'portal',
            },
          }),
        ),
      ).rejects.toThrow(/row-level security/i);
    });

    it('refuses a Contact writing a Message onto a Ticket that is not theirs', async () => {
      const otherContactId = await meridianAnonymousContact();
      const theirs = await openViaStaff(otherContactId);

      await expect(
        asContact((tx) =>
          tx.message.create({
            data: { tenantId: meridian, ticketId: theirs, body: 'Forged.' },
          }),
        ),
      ).rejects.toThrow(/row-level security/i);
    });

    /**
     * The tenant's customer list is not a Contact's to read.
     *
     * This table now holds `password_hash` alongside every customer's email and
     * name, so a tenant-wide policy here would have put the whole customer list
     * one careless handler away from being served. No endpoint exposes it today;
     * the point of the policy is that none can.
     */
    it('shows a Contact only itself in the contact table', async () => {
      const visible = await asContact((tx) =>
        tx.contact.findMany({ select: { id: true } }),
      );

      expect(visible.map((row) => row.id)).toEqual([julesId]);
    });

    /**
     * A Contact's audit reach stops at its own Tickets.
     *
     * The leak this closes is the interesting half: without the narrowing, a
     * Contact's context could read every assignment and priority change on every
     * other customer's Ticket, plus the tenant-configuration events that carry no
     * `ticket_id` at all. No endpoint serves that — `audit:read` is admin-only
     * and a Contact holds nothing — but the policy is what makes it unreachable
     * rather than merely unrouted.
     */
    it('shows a Contact audit entries only for its own Tickets', async () => {
      const mine = await openViaPortal();
      const otherContactId = await meridianAnonymousContact();
      const theirs = await openViaStaff(otherContactId);

      // Its own Ticket's creation, attributed to it.
      const ownEntries = await asContact((tx) =>
        tx.auditLog.findMany({ where: { ticketId: mine } }),
      );
      expect(ownEntries.length).toBeGreaterThan(0);
      expect(ownEntries[0].actorKind).toBe('contact');

      // And nothing at all about another customer's.
      await expect(
        asContact((tx) =>
          tx.auditLog.findMany({ where: { ticketId: theirs } }),
        ),
      ).resolves.toEqual([]);

      // Which staff can read, so the narrowing is by actor kind rather than the
      // rows simply being absent.
      const staffView = await asStaff((tx) =>
        tx.auditLog.findMany({ where: { ticketId: theirs } }),
      );
      expect(staffView.length).toBeGreaterThan(0);
    });

    /**
     * The staff axis is untouched by all of this. A regression that narrowed
     * *everyone* to their own rows would pass every test above and break the
     * product completely, so it is worth one assertion in the other direction.
     */
    it('leaves staff seeing every Ticket in their tenant', async () => {
      const mine = await openViaPortal();
      const otherContactId = await meridianAnonymousContact();
      const theirs = await openViaStaff(otherContactId);

      const visible = await asStaff((tx) =>
        tx.ticket.findMany({
          where: { id: { in: [mine, theirs] } },
          select: { id: true },
        }),
      );

      expect(visible.map((row) => row.id).sort()).toEqual(
        [mine, theirs].sort(),
      );
    });
  });

  describe('authentication', () => {
    it('refuses every portal route without a credential', async () => {
      const ticketId = await openViaPortal();

      await server().get('/portal/tickets').expect(401);
      await server().get(`/portal/tickets/${ticketId}`).expect(401);
      await server().get(`/portal/tickets/${ticketId}/messages`).expect(401);
      await server().get('/portal/auth/me').expect(401);
      await server()
        .post('/portal/tickets')
        .send({ subject: `${MARK} anonymous` })
        .expect(401);
      await server()
        .post(`/portal/tickets/${ticketId}/messages`)
        .send({ body: 'Anonymous.' })
        .expect(401);
    });
  });

  /**
   * Meridian's seeded emailless Contact — the anonymous, widget-shaped one.
   *
   * Used as "a second Contact in the same tenant", which is what makes the
   * own-rows-only claims meaningful: proving a Contact cannot see another
   * *tenant's* Tickets would only re-prove tenant isolation, which
   * `tenancy.int-spec.ts` already owns. The interesting boundary is the one
   * inside a single tenant.
   */
  const meridianAnonymousContact = async (): Promise<string> => {
    const rows = await asOwner<{ id: string }>(
      'SELECT id::text FROM contact WHERE tenant_id = $1 AND email IS NULL',
      [meridian],
    );

    if (rows.length === 0) {
      throw new Error(
        'Meridian’s anonymous seeded Contact is missing. Run `npm run db:seed`.',
      );
    }

    return rows[0].id;
  };
});
