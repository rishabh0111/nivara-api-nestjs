import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import {
  WIDGET_TOKEN_AUDIENCE,
  WIDGET_TOKEN_ISSUER,
  WIDGET_TOKEN_PREFIX,
} from 'src/widget/widget-session-token';
import { TenancyService, TenantClient } from 'src/tenancy/tenancy.service';
import { asOwner } from './helpers/as-owner';
import { bootApp } from './helpers/boot';
import { seededTenantIds } from './helpers/seeded-tenants';

/**
 * Anonymous widget sessions, end to end.
 *
 * The claims here are about a surface with **no credential behind it**, which
 * is what makes the integration form necessary rather than preferable. A unit
 * test can show that `originIsAllowed` returns false; only this can show that
 * the refusal actually reaches the endpoint, that the tenant a session acts in
 * comes from a signature rather than from anything a caller sends, and that a
 * revoked row stops working on the next request.
 *
 * Several tests reach past the application entirely — arming a context by hand
 * and asking Postgres directly — for the reason `portal.int-spec.ts` gives: a
 * surface that filters correctly on top of a database that would answer anyway
 * is one refactor away from leaking, and only the direct query tells the two
 * apart.
 *
 * The seeded origins are the fixture. Meridian allows
 * `https://meridian.example` and `http://localhost:3000`; Sortwood allows
 * `https://sortwood.example` plus the two origins the widget demo is embedded
 * from. What this suite needs is only that the two lists stay disjoint, which
 * is what makes a refusal attributable to the tenant rather than the origin.
 *
 * Requires `docker compose up -d postgres && npm run db:migrate && npm run
 * db:seed`; see `npm run test:int`.
 */

const MERIDIAN_ORIGIN = 'https://meridian.example';
const SORTWOOD_ORIGIN = 'https://sortwood.example';

const PASSWORD = 'nivara-demo-password';

/** Stamped on every Ticket this suite writes, so cleanup can find them all. */
const MARK = 'widget-int-spec';

describe('widget sessions', () => {
  let app: INestApplication;
  let meridian: string;
  let sortwood: string;
  let agentToken: string;

  beforeAll(async () => {
    app = await bootApp();
    ({ meridian, sortwood } = await seededTenantIds());
    agentToken = await staffTokenFor(meridian, 'agent@meridian.test');
  });

  afterAll(async () => {
    await app?.close();

    // Tickets first — the Contacts below are their requesters, and the FK is
    // `Cascade` from contact to ticket but this suite deletes by subject, so
    // order matters for the sessions and Contacts left behind.
    await asOwner(`DELETE FROM ticket WHERE subject LIKE '${MARK}%'`);
    await asOwner(
      `DELETE FROM widget_session WHERE contact_id IN
         (SELECT id FROM contact WHERE email IS NULL AND created_at > now() - interval '1 hour')`,
    );
  });

  const server = () => request(app.getHttpServer());

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

  /** A live Meridian widget session, as a visitor's page would obtain one. */
  const startSession = async (
    tenantId = meridian,
    origin = MERIDIAN_ORIGIN,
  ): Promise<string> => {
    const { body } = await server()
      .post('/widget/sessions')
      .set('Origin', origin)
      .send({ tenantId })
      .expect(201);

    return body.token as string;
  };

  const sessionIdOf = (token: string): string => {
    const jwt = new JwtService();
    const claims = jwt.decode(token.slice(WIDGET_TOKEN_PREFIX.length));

    return claims.sub;
  };

  const get = (token: string, path: string) =>
    server().get(path).set('Authorization', `Bearer ${token}`);

  const post = (token: string, path: string, body: object = {}) =>
    server().post(path).set('Authorization', `Bearer ${token}`).send(body);

  /** The Contact a session has resolved, read as the owner. */
  const contactIdOfSession = async (token: string): Promise<string> => {
    const rows = await asOwner<{ contact_id: string | null }>(
      'SELECT contact_id::text FROM widget_session WHERE id = $1',
      [sessionIdOf(token)],
    );

    const contactId = rows[0]?.contact_id;

    if (!contactId) {
      throw new Error(
        'This session has not resolved a Contact — open a Ticket on it first.',
      );
    }

    return contactId;
  };

  /** When a session's row says it expires. The authority renewal moves. */
  const expiresAtOf = async (token: string): Promise<string> => {
    const rows = await asOwner<{ expires_at: string }>(
      'SELECT expires_at::text FROM widget_session WHERE id = $1',
      [sessionIdOf(token)],
    );

    return rows[0].expires_at;
  };

  /** Opens a Ticket from a widget session and returns its id. */
  const openTicket = async (token: string, suffix = ''): Promise<string> => {
    const { body } = await post(token, '/widget/tickets', {
      subject: `${MARK} ${suffix}`.trim(),
    }).expect(201);

    return body.id as string;
  };

  // -------------------------------------------------------------------------
  // The Origin gate
  // -------------------------------------------------------------------------

  describe('the bootstrap endpoint', () => {
    it('mints a session for an allowlisted origin, with no credential at all', async () => {
      const { body } = await server()
        .post('/widget/sessions')
        .set('Origin', MERIDIAN_ORIGIN)
        .send({ tenantId: meridian })
        .expect(201);

      // Prefixed so the guard knows which verifier to hand it to, and
      // time-boxed so a scraped token is a bounded problem.
      expect(String(body.token).startsWith(WIDGET_TOKEN_PREFIX)).toBe(true);
      expect(body.expiresInSeconds).toBe(30 * 60);
    });

    it('refuses a request from a non-allowlisted origin', async () => {
      const { body } = await server()
        .post('/widget/sessions')
        .set('Origin', 'https://attacker.example')
        .send({ tenantId: meridian })
        .expect(403);

      expect(body.error.code).toBe('forbidden');
    });

    /**
     * The allowlist is *per tenant*, which is the claim that stops one
     * customer's widget being embedded on another's site. Sortwood's origin is
     * a perfectly valid origin — just not for Meridian.
     */
    it('refuses an origin that is allowlisted for a different tenant', async () => {
      await server()
        .post('/widget/sessions')
        .set('Origin', SORTWOOD_ORIGIN)
        .send({ tenantId: meridian })
        .expect(403);

      await server()
        .post('/widget/sessions')
        .set('Origin', MERIDIAN_ORIGIN)
        .send({ tenantId: sortwood })
        .expect(403);
    });

    it('refuses a caller that presented no origin at all', async () => {
      await server()
        .post('/widget/sessions')
        .send({ tenantId: meridian })
        .expect(403);
    });

    /**
     * An unknown tenant takes the *same* refusal a disallowed origin does. A
     * 404 here would turn a public endpoint into an oracle for whether a given
     * uuid names a customer of this service.
     */
    it('refuses an unknown tenant indistinguishably from a bad origin', async () => {
      const { body } = await server()
        .post('/widget/sessions')
        .set('Origin', MERIDIAN_ORIGIN)
        .send({ tenantId: '019f0000-0000-7000-8000-000000000000' })
        .expect(403);

      expect(body.error.code).toBe('forbidden');
    });

    /** No session row is left behind by a refusal. */
    it('writes nothing when it refuses', async () => {
      const before = await asOwner<{ count: string }>(
        'SELECT count(*)::text FROM widget_session WHERE tenant_id = $1',
        [meridian],
      );

      await server()
        .post('/widget/sessions')
        .set('Origin', 'https://attacker.example')
        .send({ tenantId: meridian })
        .expect(403);

      const after = await asOwner<{ count: string }>(
        'SELECT count(*)::text FROM widget_session WHERE tenant_id = $1',
        [meridian],
      );

      expect(after[0].count).toBe(before[0].count);
    });
  });

  // -------------------------------------------------------------------------
  // The signed tenant identity
  // -------------------------------------------------------------------------

  describe('the session token', () => {
    /**
     * The end-to-end proof that the chain is wired: token → principal →
     * `withTenant()` → a row that is only visible from inside the context that
     * token armed.
     *
     * It deliberately opens a Ticket first. A read on a *fresh* session would
     * answer 200 without touching the database at all — `existingContactPrincipal`
     * returns null and the handler short-circuits to an empty page — so the
     * obvious one-line version of this test proves only that the route exists.
     * The Ticket forces a Contact to be resolved and then reads it back through
     * the policy.
     */
    it('arms `withTenant()` and yields a uniform principal', async () => {
      const token = await startSession();
      const ticketId = await openTicket(token, 'arming');

      const { body } = await get(token, '/widget/tickets').expect(200);

      expect(body.data.map((t: { id: string }) => t.id)).toContain(ticketId);
    });

    /**
     * The load-bearing claim of the whole surface. The tenant is not a
     * parameter of any request after bootstrap — it is a signed claim — so
     * there is no field to tamper with. What this proves is the consequence:
     * a Meridian session sees Meridian's rows and nothing of Sortwood's, even
     * naming a Sortwood Ticket id directly.
     */
    it('cannot act on a tenant it was not signed for', async () => {
      const meridianToken = await startSession();
      await openTicket(meridianToken, 'tenant-scope');

      const sortwoodToken = await startSession(sortwood, SORTWOOD_ORIGIN);
      const sortwoodTicket = await openTicket(sortwoodToken, 'sortwood');

      // Named directly, and still 404: another tenant's Ticket does not exist
      // in this context, which is the same answer a nonexistent one gets.
      await get(meridianToken, `/widget/tickets/${sortwoodTicket}`).expect(404);

      const { body } = await get(meridianToken, '/widget/tickets').expect(200);

      expect(
        body.data.every((t: { id: string }) => t.id !== sortwoodTicket),
      ).toBe(true);
    });

    /**
     * Widget sessions are signed with `WIDGET_SESSION_SECRET`, staff tokens
     * with `JWT_SECRET`. A token forged under the wrong key fails at the
     * signature, before any claim is read — which is why the two keys are
     * worth keeping distinct.
     */
    it('refuses a session forged with the staff signing key', async () => {
      const jwt = new JwtService();

      const forged = await jwt.signAsync(
        {
          kind: 'widget',
          sub: '019f0000-0000-7000-8000-0000000000ff',
          tenantId: meridian,
        },
        {
          secret: process.env['JWT_SECRET']!,
          issuer: WIDGET_TOKEN_ISSUER,
          audience: WIDGET_TOKEN_AUDIENCE,
          expiresIn: 600,
        },
      );

      await get(`${WIDGET_TOKEN_PREFIX}${forged}`, '/widget/tickets').expect(
        401,
      );
    });

    /**
     * And the converse. A widget session is not a staff credential, and the
     * refusal is a 403 from the kind axis rather than a 401 — the credential
     * is genuine, it is simply not the sort of principal that surface serves.
     */
    it('is refused at a staff route', async () => {
      const token = await startSession();

      await get(token, '/auth/me').expect(403);
      await get(token, '/tickets').expect(403);
    });

    /**
     * A validly-signed token naming a session row that does not exist. The
     * signature is genuine; the session is not, which is exactly why
     * verification consults the row rather than trusting the claims.
     */
    it('refuses a signed token whose session row is absent', async () => {
      const jwt = new JwtService();

      const orphan = await jwt.signAsync(
        {
          kind: 'widget',
          sub: '019f0000-0000-7000-8000-0000000000fe',
          tenantId: meridian,
        },
        {
          secret: process.env['WIDGET_SESSION_SECRET']!,
          issuer: WIDGET_TOKEN_ISSUER,
          audience: WIDGET_TOKEN_AUDIENCE,
          expiresIn: 600,
        },
      );

      await get(`${WIDGET_TOKEN_PREFIX}${orphan}`, '/widget/tickets').expect(
        401,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Revocation and renewal — the reason the row exists
  // -------------------------------------------------------------------------

  describe('the backing session row', () => {
    it('kills exactly the session it names and no other', async () => {
      const doomed = await startSession();
      const bystander = await startSession();

      await get(doomed, '/widget/tickets').expect(200);
      await get(bystander, '/widget/tickets').expect(200);

      await asOwner(
        'UPDATE widget_session SET revoked_at = now() WHERE id = $1',
        [sessionIdOf(doomed)],
      );

      // The revoked session stops working on its very next request, which is
      // the whole point of paying for a per-request row read.
      await get(doomed, '/widget/tickets').expect(401);
      // And the bystander is untouched — this is what "and no other" means,
      // and what rotating the signing secret could not have given us.
      await get(bystander, '/widget/tickets').expect(200);
    });

    it('refuses a session whose row has expired, however valid the token', async () => {
      const token = await startSession();

      await asOwner(
        `UPDATE widget_session SET expires_at = now() - interval '1 minute' WHERE id = $1`,
        [sessionIdOf(token)],
      );

      await get(token, '/widget/tickets').expect(401);
    });

    it('renews silently, and the renewed token works', async () => {
      const original = await startSession();
      const ticket = await openTicket(original, 'renewal');
      const before = await expiresAtOf(original);

      const { body } = await post(original, '/widget/sessions/renew')
        .set('Origin', MERIDIAN_ORIGIN)
        .expect(200);

      const expiresAt = await expiresAtOf(original);

      const renewed = body.token as string;

      expect(body.expiresInSeconds).toBe(30 * 60);

      // The row's expiry is the authority, and it is what actually moved.
      // Asserting the *token* differs would be asserting a coincidence: the
      // claims are identical apart from `iat`/`exp`, so two renewals inside one
      // second sign the same bytes — which is harmless, since it is the same
      // session with the same window.
      expect(new Date(expiresAt).getTime()).toBeGreaterThan(
        new Date(before).getTime(),
      );

      // The same session, so the same Contact and therefore the same
      // conversation: a chat that runs past thirty minutes is one chat.
      expect(sessionIdOf(renewed)).toBe(sessionIdOf(original));
      await get(renewed, `/widget/tickets/${ticket}`).expect(200);
    });

    it('refuses to renew a revoked session back into life', async () => {
      const token = await startSession();

      await asOwner(
        'UPDATE widget_session SET revoked_at = now() WHERE id = $1',
        [sessionIdOf(token)],
      );

      await post(token, '/widget/sessions/renew')
        .set('Origin', MERIDIAN_ORIGIN)
        .expect(401);
    });

    /**
     * Renewal re-checks the allowlist, so a token lifted onto another page
     * cannot keep itself alive from there once its thirty minutes are up.
     */
    it('refuses to renew from a non-allowlisted origin', async () => {
      const token = await startSession();

      await post(token, '/widget/sessions/renew')
        .set('Origin', 'https://attacker.example')
        .expect(403);
    });
  });

  // -------------------------------------------------------------------------
  // Anonymity: the Contact appears only when it must
  // -------------------------------------------------------------------------

  describe('the contact reference', () => {
    const contactIdOf = async (token: string): Promise<string | null> => {
      const rows = await asOwner<{ contact_id: string | null }>(
        'SELECT contact_id::text FROM widget_session WHERE id = $1',
        [sessionIdOf(token)],
      );

      return rows[0].contact_id;
    };

    it('is null at mint — nothing durable about the visitor is stored', async () => {
      const token = await startSession();

      expect(await contactIdOf(token)).toBeNull();
    });

    /**
     * The read paths must not resolve a Contact. A visitor who opens the
     * widget and browses has said nothing, and creating a row to discover they
     * own nothing is exactly the durable trace this surface promises not to
     * leave.
     */
    it('stays null while the visitor only reads', async () => {
      const token = await startSession();

      const { body } = await get(token, '/widget/tickets').expect(200);

      expect(body.data).toEqual([]);
      expect(await contactIdOf(token)).toBeNull();

      // Naming a Ticket id answers 404 rather than minting an identity to
      // check with.
      await get(
        token,
        '/widget/tickets/019f0000-0000-7000-8000-00000000000a',
      ).expect(404);

      expect(await contactIdOf(token)).toBeNull();
    });

    it('is set by the first act that needs a requester', async () => {
      const token = await startSession();

      const ticketId = await openTicket(token, 'resolution');
      const contactId = await contactIdOf(token);

      expect(contactId).not.toBeNull();

      // Anonymous in every column: no email, no name, unverified, and no
      // portal credential. Identifying themselves later is a write to this
      // row, not a different kind of Contact.
      const [contact] = await asOwner<{
        email: string | null;
        name: string | null;
        verified: boolean;
        password_hash: string | null;
      }>(
        'SELECT email, name, verified, password_hash FROM contact WHERE id = $1',
        [contactId],
      );

      expect(contact).toMatchObject({
        email: null,
        name: null,
        verified: false,
        password_hash: null,
      });

      // And the Ticket points at it, with the Source this surface fixes.
      const [ticket] = await asOwner<{ contact_id: string; source: string }>(
        'SELECT contact_id::text, source FROM ticket WHERE id = $1',
        [ticketId],
      );

      expect(ticket.contact_id).toBe(contactId);
      expect(ticket.source).toBe('widget');
    });

    it('is reused, so two Tickets in one session are one customer', async () => {
      const token = await startSession();

      await openTicket(token, 'first');
      const after = await contactIdOf(token);

      await openTicket(token, 'second');

      expect(await contactIdOf(token)).toBe(after);
    });
  });

  // -------------------------------------------------------------------------
  // The conversation
  // -------------------------------------------------------------------------

  describe('a visitor’s conversation', () => {
    it('opens a Ticket and exchanges Messages on it', async () => {
      const token = await startSession();
      const ticketId = await openTicket(token, 'conversation');

      const { body: mine } = await post(
        token,
        `/widget/tickets/${ticketId}/messages`,
        { body: 'My order never arrived.' },
      ).expect(201);

      expect(mine.ticketId).toBe(ticketId);
      // Stamped by the trigger from the armed context, not claimed by the
      // request — a widget visitor arms `contact`, exactly as the portal does.
      expect(mine.authorKind).toBe('contact');

      // An agent answers on the same Ticket, through the staff surface.
      await post(agentToken, `/tickets/${ticketId}/messages`, {
        body: 'Sorry about that — we are looking into it.',
      }).expect(201);

      const { body: thread } = await get(
        token,
        `/widget/tickets/${ticketId}/messages`,
      ).expect(200);

      expect(thread.data).toHaveLength(2);
      expect(
        thread.data.map((m: { authorKind: string }) => m.authorKind),
      ).toEqual(expect.arrayContaining(['contact', 'user']));
    });

    /**
     * Notes are excluded three independent ways — no route here names one, no
     * grant a widget session holds mentions them, and the policy makes the
     * rows invisible to a contact-armed context. This asserts the outcome.
     */
    it('cannot see an agent’s Note on its own Ticket', async () => {
      const token = await startSession();
      const ticketId = await openTicket(token, 'notes');

      await post(agentToken, `/tickets/${ticketId}/notes`, {
        body: 'Internal: refund already issued, do not tell them yet.',
      }).expect(201);

      const { body } = await get(
        token,
        `/widget/tickets/${ticketId}/messages`,
      ).expect(200);

      expect(body.data).toEqual([]);

      // No route on this surface serves Notes at all.
      await get(token, `/widget/tickets/${ticketId}/notes`).expect(404);
    });

    it('cannot reach another visitor’s Ticket', async () => {
      const mine = await startSession();
      const theirs = await startSession();

      const theirTicket = await openTicket(theirs, 'privacy');

      // 404 rather than 403 — a 403 would confirm somebody else's support
      // request is real.
      await get(mine, `/widget/tickets/${theirTicket}`).expect(404);
      await get(mine, `/widget/tickets/${theirTicket}/messages`).expect(404);
      await post(mine, `/widget/tickets/${theirTicket}/messages`, {
        body: 'let me in',
      }).expect(404);
    });

    it('cannot perform any staff operation', async () => {
      const token = await startSession();
      const ticketId = await openTicket(token, 'authority');

      // Every staff route refuses on the principal-kind axis, before any
      // question of grants — a widget session holds no permission at all.
      await post(token, `/tickets/${ticketId}/notes`, { body: 'x' }).expect(
        403,
      );
      await get(token, `/tickets/${ticketId}/audit`).expect(403);
      await get(token, '/tickets').expect(403);

      await server()
        .patch(`/tickets/${ticketId}/state`)
        .set('Authorization', `Bearer ${token}`)
        .send({ state: 'closed' })
        .expect(403);

      await server()
        .patch(`/tickets/${ticketId}/priority`)
        .set('Authorization', `Bearer ${token}`)
        .send({ priority: 'urgent' })
        .expect(403);
    });

    /**
     * The reply-reopen rule is not reimplemented here — the
     * widget calls the same `ContactReplyService` the portal does. This is the
     * check that it is genuinely the same path, and that a widget reply is
     * therefore not a second implementation waiting to disagree.
     */
    it('reopens a resolved Ticket by replying, exactly as the portal does', async () => {
      const token = await startSession();
      const ticketId = await openTicket(token, 'reopen');

      await server()
        .patch(`/tickets/${ticketId}/state`)
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ state: 'resolved' })
        .expect(200);

      await post(token, `/widget/tickets/${ticketId}/messages`, {
        body: 'This is still broken.',
      }).expect(201);

      const { body } = await get(token, `/widget/tickets/${ticketId}`).expect(
        200,
      );

      expect(body.state).toBe('open');
    });
  });

  // -------------------------------------------------------------------------
  // Beneath the application
  // -------------------------------------------------------------------------

  /**
   * The claims above are all made through the API. These are made against
   * Postgres directly, with a context armed by hand, because a surface that
   * behaves correctly on top of a database that would answer anyway is one
   * refactor from leaking — and because two of the three ports that will run
   * against this schema share none of the code above.
   */
  describe('beneath the application', () => {
    /**
     * Armed as the application's own runtime role, deliberately *not* through
     * `asOwnerArmed`. That helper connects as the database owner, which is a
     * superuser and therefore not subject to row-level security at all — every
     * assertion below would pass against it while proving nothing. Going
     * through `TenancyService` is what makes these tests about the policy
     * rather than about the query. `portal.int-spec.ts` makes the same choice
     * for the same reason.
     */
    const asVisitor = <T>(
      contactId: string,
      work: (tx: TenantClient) => Promise<T>,
    ): Promise<T> =>
      app
        .get(TenancyService)
        .withTenant(
          { tenantId: meridian, actor: { kind: 'contact', id: contactId } },
          work,
        );

    it('hides one visitor’s Ticket from another’s armed context', async () => {
      const mine = await startSession();
      const theirs = await startSession();

      const theirTicket = await openTicket(theirs, 'rls');
      // Opened so that `mine` resolves a Contact to arm a context with.
      await openTicket(mine, 'rls-mine');

      const rows = await asVisitor(await contactIdOfSession(mine), (tx) =>
        tx.ticket.findMany({ where: { id: theirTicket } }),
      );

      // Not filtered out of the result — absent from the context entirely.
      expect(rows).toEqual([]);
    });

    it('hides one visitor’s session row from another’s armed context', async () => {
      const mine = await startSession();
      const theirs = await startSession();

      await openTicket(mine, 'session-rls');
      await openTicket(theirs, 'session-rls-other');

      const rows = await asVisitor(await contactIdOfSession(mine), (tx) =>
        tx.widgetSession.findMany({ where: { id: sessionIdOf(theirs) } }),
      );

      expect(rows).toEqual([]);
    });

    /**
     * The control for the two tests above. They assert that an armed context
     * finds *no* row; this asserts the row is genuinely there to be found, from
     * a connection that outranks the policies. Without it, both would pass just
     * as happily against a bootstrap endpoint that silently wrote nothing.
     */
    it('has the rows the armed reads could not see', async () => {
      const token = await startSession();

      const rows = await asOwner<{ id: string }>(
        'SELECT id::text FROM widget_session WHERE id = $1',
        [sessionIdOf(token)],
      );

      expect(rows).toHaveLength(1);
    });
  });
});
