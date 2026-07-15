import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { asOwner } from './helpers/as-owner';
import { REFRESH_COOKIE } from 'src/auth/refresh-cookie';
import { GoogleIdentity } from 'src/auth/google-id-token';
import { GoogleOidcClient } from 'src/auth/google-client';
import { bootApp } from './helpers/boot';
import { seededTenantIds } from './helpers/seeded-tenants';

/**
 * Google sign-in, end to end and against a real database.
 *
 * Only the network is stubbed. Everything this ticket actually promises is a
 * property of a row or of a session — that a verified email reaches the invited
 * User rather than a second one, that the link is written, that the same address
 * at two tenants stays two Users, that an uninvited Google account is refused —
 * and none of it survives being mocked. A fake user store would happily
 * demonstrate a binding no unique index ever enforced.
 *
 * The stub stands exactly at `GoogleOidcClient`, which is the seam that class
 * exists to be: the claim checks above it have their own unit suite, and what is
 * left below is the part with a database in it.
 *
 * Requires `docker compose up -d postgres && npm run db:migrate && npm run
 * db:seed`; see `npm run test:int`.
 */

/** The seed gives this address a Google subject already; nobody else has one. */
const LINKED_EMAIL = 'dual@example.test';
const LINKED_SUBJECT = '100000000000000000042';

/** Meridian's admin: invited, password-holding, and not yet linked to Google. */
const UNLINKED_EMAIL = 'admin@meridian.test';

/**
 * A `GoogleOidcClient` that answers with whatever the test last decided Google
 * would say, and never opens a socket.
 *
 * Configured is hard-coded true. Whether an *unconfigured* deployment refuses is
 * the one claim this stub could not honestly make, so it is asserted in
 * `boot.e2e-spec.ts` against the real class instead.
 */
class StubGoogle {
  answer: GoogleIdentity | null = null;

  readonly isConfigured = true;

  /** Every exchange in this suite; the code itself is never inspected. */
  exchange(): Promise<GoogleIdentity | null> {
    return Promise.resolve(this.answer);
  }
}

describe('Google sign-in', () => {
  let app: INestApplication;
  let google: StubGoogle;
  let meridian: string;
  let sortwood: string;

  beforeAll(async () => {
    google = new StubGoogle();
    app = await bootApp({
      overrides: [{ provide: GoogleOidcClient, useValue: google }],
    });
    ({ meridian, sortwood } = await seededTenantIds());
  });

  afterAll(async () => {
    await app?.close();
  });

  const server = () => request(app.getHttpServer());

  /** Signs in as whoever Google is currently willing to vouch for. */
  const signInWithGoogle = (
    tenantId: string,
    identity: GoogleIdentity | null,
  ) => {
    google.answer = identity;

    return server().post('/auth/google').send({
      tenantId,
      code: 'an-authorization-code',
      redirectUri: 'https://app.nivara.example/auth/google/callback',
    });
  };

  /**
   * The `user` row behind an address, or `null` if there is none.
   *
   * Read as the owner, from outside the policy system, for the reason
   * `seededTenantIds` does: the assertions are about columns, and reaching them
   * through the API would only re-read what the API just said. The absent case
   * is `null` rather than a throw because "no such row" is itself something a
   * test below asserts.
   */
  const userRow = async (
    tenantId: string,
    email: string,
  ): Promise<{ google_subject: string | null } | null> => {
    const rows = await asOwner<{ google_subject: string | null }>(
      'SELECT google_subject FROM "user" WHERE tenant_id = $1 AND email = $2',
      [tenantId, email],
    );

    return rows[0] ?? null;
  };

  describe('the session it produces', () => {
    it('answers the same body and cookie the password path does', async () => {
      const response = await signInWithGoogle(meridian, {
        subject: LINKED_SUBJECT,
        email: LINKED_EMAIL,
      }).expect(200);

      expect(response.body).toEqual({
        accessToken: expect.any(String),
        expiresInSeconds: 15 * 60,
      });

      const header = response.headers['set-cookie'] as unknown as string[];
      const cookie = header.find((line) =>
        line.startsWith(`${REFRESH_COOKIE}=`),
      );

      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Path=/auth');
      expect(cookie).toContain('SameSite=Lax');
    });

    /**
     * The cookie is a real, rotatable refresh token rather than a lookalike —
     * which is what "identical to the password path" has to mean if it means
     * anything. A session that could not be refreshed would satisfy every
     * shape assertion above and still be a different session.
     */
    it('mints a refresh token the ordinary refresh route accepts', async () => {
      const signedIn = await signInWithGoogle(meridian, {
        subject: LINKED_SUBJECT,
        email: LINKED_EMAIL,
      }).expect(200);

      const header = signedIn.headers['set-cookie'] as unknown as string[];
      const cookie = header
        .find((line) => line.startsWith(`${REFRESH_COOKIE}=`))!
        .split(';')[0];

      await server().post('/auth/refresh').set('Cookie', cookie).expect(200);
    });
  });

  describe('binding to an invited User', () => {
    /**
     * The heart of the ticket. This address has a password and no Google link;
     * signing in with Google must reach *that* User, not create a second one.
     */
    it('reaches the existing invite-provisioned User and links the subject', async () => {
      const subject = `999${Date.now()}`;

      const signedIn = await signInWithGoogle(meridian, {
        subject,
        email: UNLINKED_EMAIL,
      }).expect(200);

      const me = await server()
        .get('/auth/me')
        .set('Authorization', `Bearer ${signedIn.body.accessToken}`)
        .expect(200);

      // Same person, same role, same row — reached by a credential they had not
      // used before.
      expect(me.body).toMatchObject({
        email: UNLINKED_EMAIL,
        role: 'admin',
        tenantId: meridian,
      });

      // And the link is written, which is what makes the next sign-in a subject
      // match rather than an email one.
      expect(await userRow(meridian, UNLINKED_EMAIL)).toEqual({
        google_subject: subject,
      });

      // Restored, so this test does not leave the seeded row carrying a subject
      // the seed did not put there — the suite is re-runnable without reseeding.
      await unlink(meridian, UNLINKED_EMAIL);
    });

    /**
     * A person whose Google address changed. The subject is what survives that,
     * which is why it is the first lookup rather than a cache of the second.
     */
    it('matches a linked User on the subject even when the email no longer agrees', async () => {
      const signedIn = await signInWithGoogle(meridian, {
        subject: LINKED_SUBJECT,
        email: 'iris.vance.new-address@example.test',
      }).expect(200);

      const me = await server()
        .get('/auth/me')
        .set('Authorization', `Bearer ${signedIn.body.accessToken}`)
        .expect(200);

      expect(me.body).toMatchObject({ email: LINKED_EMAIL, role: 'agent' });
    });

    /**
     * Tenant-local identity, demonstrated rather than asserted. One Google
     * account, two tenants, two Users — and the roles differ, so resolving the
     * wrong row would show in the authority handed back, not only in the id.
     */
    it('resolves one Google account at two tenants to two distinct Users', async () => {
      const identity = { subject: LINKED_SUBJECT, email: LINKED_EMAIL };

      const atMeridian = await signInWithGoogle(meridian, identity).expect(200);
      const atSortwood = await signInWithGoogle(sortwood, identity).expect(200);

      const one = decodeClaims(atMeridian.body.accessToken as string);
      const other = decodeClaims(atSortwood.body.accessToken as string);

      expect(one.sub).not.toEqual(other.sub);
      expect(one.role).toBe('agent');
      expect(other.role).toBe('admin');
    });
  });

  describe('what it refuses', () => {
    /**
     * The refusal the whole design rests on. Membership comes from an invite and
     * from nothing else, so a perfectly good Google account that nobody invited
     * gets a session at no tenant — otherwise anyone holding a Google account and
     * a tenant id could join a tenant that never asked for them.
     */
    it('refuses a verified Google identity nobody invited, rather than provisioning one', async () => {
      const response = await signInWithGoogle(meridian, {
        subject: '111111111111111111111',
        email: 'stranger@example.test',
      }).expect(401);

      expect(response.body.error.code).toBe('unauthenticated');

      // No User was provisioned, which is the half a status code cannot show —
      // and the assertion is that the row does not exist at all, not that it
      // exists without a link.
      expect(await userRow(meridian, 'stranger@example.test')).toBeNull();
    });

    /**
     * The sharp edge of binding by email. This address is already linked to one
     * Google account; a *second* Google account that can prove the same verified
     * address must not silently take the row over. A verified email proves who
     * controls that address today, which is not the same as continuity with
     * whoever held it when the link was made — addresses get transferred and
     * Workspace accounts get recreated.
     */
    it('refuses a second Google account claiming an already-linked address', async () => {
      const response = await signInWithGoogle(meridian, {
        subject: '222222222222222222222',
        email: LINKED_EMAIL,
      }).expect(401);

      expect(response.body.error.code).toBe('unauthenticated');

      // And the original link is untouched, which is the half that matters —
      // a refusal that still overwrote the column would be the same bug.
      expect(await userRow(meridian, LINKED_EMAIL)).toEqual({
        google_subject: LINKED_SUBJECT,
      });
    });

    /**
     * A real, linked Google identity quoted against the wrong tenant. It is
     * refused exactly as a stranger is: the lookup runs inside Meridian's
     * context, so Sortwood's row is not merely disallowed but invisible.
     */
    it('refuses a real identity quoted against a tenant that did not invite it', async () => {
      const stranger = await signInWithGoogle(sortwood, {
        subject: '111111111111111111111',
        email: 'stranger@example.test',
      }).expect(401);

      const wrongTenant = await signInWithGoogle(sortwood, {
        subject: `${LINKED_SUBJECT}-not-sortwoods`,
        email: UNLINKED_EMAIL,
      }).expect(401);

      expect(wrongTenant.body).toEqual(stranger.body);
    });

    /** Google declining is one refusal with everything else, deliberately. */
    it('refuses indistinguishably when Google will not vouch at all', async () => {
      const refusedByGoogle = await signInWithGoogle(meridian, null).expect(
        401,
      );

      const uninvited = await signInWithGoogle(meridian, {
        subject: '111111111111111111111',
        email: 'stranger@example.test',
      }).expect(401);

      expect(refusedByGoogle.body).toEqual(uninvited.body);
    });

    /**
     * The gap the password path closes only by accident. A User row outlives its
     * invitation, and sign-in refuses an unaccepted invitee purely because there
     * is no password hash to compare against — so Google, which needs no hash,
     * would walk straight past an invitation that aged out.
     */
    it('refuses an invitee whose invitation expired without ever being accepted', async () => {
      const invitee = await inviteSomebody(meridian, {
        email: 'expired-invitee@meridian.test',
        expiresAt: new Date(Date.now() - 60_000),
      });

      try {
        await signInWithGoogle(meridian, {
          subject: '333333333333333333333',
          email: 'expired-invitee@meridian.test',
        }).expect(401);
      } finally {
        await deleteUser(invitee);
      }
    });

    /**
     * The other side of that rule, and the reason it is acceptance rather than a
     * flat refusal: the ticket exists so an invited person does not need a second
     * credential. Signing in with Google *is* how they accept, so a live
     * invitation lets them in and is spent in the process.
     */
    it('accepts a live invitation by signing in, and spends it', async () => {
      const invitee = await inviteSomebody(meridian, {
        email: 'fresh-invitee@meridian.test',
        expiresAt: new Date(Date.now() + 60_000),
      });

      try {
        await signInWithGoogle(meridian, {
          subject: '444444444444444444444',
          email: 'fresh-invitee@meridian.test',
        }).expect(200);

        expect(await invitationAcceptedAt(invitee)).toEqual(expect.any(Date));
      } finally {
        await deleteUser(invitee);
      }
    });

    it.each([
      ['a tenant that is not a uuid', { tenantId: 'meridian' }],
      ['no code', { code: undefined }],
      ['a redirect that is not a url', { redirectUri: 'not a url' }],
    ])('refuses %s as unprocessable', async (_case, overrides) => {
      google.answer = { subject: LINKED_SUBJECT, email: LINKED_EMAIL };

      const response = await server()
        .post('/auth/google')
        .send({
          tenantId: meridian,
          code: 'an-authorization-code',
          redirectUri: 'https://app.nivara.example/auth/google/callback',
          ...overrides,
        })
        .expect(422);

      expect(response.body.error.code).toBe('validation_failed');
    });
  });

  /** Puts a seeded row back the way the seed left it. */
  const unlink = async (tenantId: string, email: string): Promise<void> => {
    await asOwner(
      'UPDATE "user" SET google_subject = NULL WHERE tenant_id = $1 AND email = $2',
      [tenantId, email],
    );
  };

  /**
   * Provisions a pending User and the invitation that made it, exactly as the
   * invite endpoint would — a row with no password, and an unspent invitation.
   *
   * Written directly rather than through the API because the interesting cases
   * are an *expired* invitation and one accepted by a route other than the
   * acceptance endpoint, neither of which the API will produce on request.
   *
   * Returns the new User's id, which is also how the invitation is found again.
   */
  const inviteSomebody = async (
    tenantId: string,
    invitee: { email: string; expiresAt: Date },
  ): Promise<string> => {
    const rows = await asOwner<{ id: string }>(
      `INSERT INTO "user" (id, tenant_id, email, name, role, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'Pending Person', 'agent', now(), now())
       RETURNING id::text`,
      [tenantId, invitee.email],
    );

    const userId = rows[0].id;

    // `invited_by_id` is any real admin of this tenant; who issued it is not
    // what these tests are about, only that an invitation exists.
    await asOwner(
      `INSERT INTO staff_invitation (id, tenant_id, user_id, token_hash, invited_by_id, expires_at, created_at)
       SELECT gen_random_uuid(), $1, $2, $3, u.id, $4, now()
         FROM "user" u
        WHERE u.tenant_id = $1 AND u.role = 'admin'
        LIMIT 1`,
      [tenantId, userId, `hash-for-${invitee.email}`, invitee.expiresAt],
    );

    return userId;
  };

  /** When the invitation behind a User was spent, or `null` if it never was. */
  const invitationAcceptedAt = async (userId: string): Promise<Date | null> => {
    const rows = await asOwner<{ accepted_at: Date | null }>(
      'SELECT accepted_at FROM staff_invitation WHERE user_id = $1',
      [userId],
    );

    return rows[0]?.accepted_at ?? null;
  };

  /** Cascades to the invitation and any session, so a test leaves nothing behind. */
  const deleteUser = async (userId: string): Promise<void> => {
    await asOwner('DELETE FROM "user" WHERE id = $1', [userId]);
  };
});

/**
 * Reads a JWT's payload without verifying it. Appropriate in a test asserting
 * what the server put in a token, and nowhere in `src`.
 */
function decodeClaims(token: string): { sub: string; role: string } {
  return JSON.parse(
    Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
  ) as { sub: string; role: string };
}
