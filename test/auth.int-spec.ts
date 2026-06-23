import { INestApplication } from '@nestjs/common';
import { createHash, createHmac } from 'node:crypto';
import { Client } from 'pg';
import request from 'supertest';
import { REFRESH_COOKIE } from 'src/auth/refresh-cookie';
import { bootApp } from './helpers/boot';
import { seededTenantIds } from './helpers/seeded-tenants';

/**
 * Staff authentication, end to end and against a real database.
 *
 * Everything worth asserting here is a property of a Postgres row, a policy,
 * or a cookie flag — rotation, family eviction, hashed-at-rest storage, the
 * tenant claim reaching row-level security. None of it survives being mocked:
 * a fake token store would happily demonstrate a rotation scheme that no
 * database ever enforced.
 *
 * Requires `docker compose up -d postgres && npm run db:migrate && npm run
 * db:seed`; see `npm run test:int`.
 */

/** The password the seed gives every seeded User. */
const PASSWORD = 'nivara-demo-password';

/** An address the seed deliberately creates in *both* tenants. */
const SHARED_EMAIL = 'dual@example.test';

describe('staff authentication', () => {
  let app: INestApplication;
  let meridian: string;
  let sortwood: string;

  beforeAll(async () => {
    app = await bootApp();
    ({ meridian, sortwood } = await seededTenantIds());
  });

  afterAll(async () => {
    await app?.close();
  });

  const server = () => request(app.getHttpServer());

  const signIn = (tenantId: string, email: string, password = PASSWORD) =>
    server().post('/auth/sign-in').send({ tenantId, email, password });

  /** Pulls the refresh cookie's value out of a `Set-Cookie` header. */
  const refreshCookie = (response: request.Response): string => {
    const header = response.headers['set-cookie'] as unknown as string[];
    const cookie = header.find((line) => line.startsWith(`${REFRESH_COOKIE}=`));

    if (!cookie) throw new Error('No refresh cookie was set.');

    return cookie.split(';')[0];
  };

  describe('signing in', () => {
    it('returns an access token and sets a refresh cookie', async () => {
      const response = await signIn(meridian, 'admin@meridian.test').expect(
        200,
      );

      expect(response.body).toEqual({
        accessToken: expect.any(String),
        expiresInSeconds: 15 * 60,
      });

      // The refresh token leaves in the cookie and nowhere else. A copy in the
      // body would hand a page script exactly what httpOnly withholds.
      expect(JSON.stringify(response.body)).not.toContain(REFRESH_COOKIE);
    });

    /**
     * The flags are the storage half of the promise in the ticket: hashed at
     * rest, and unreadable by script in transit.
     */
    it('delivers the refresh token httpOnly', async () => {
      const response = await signIn(meridian, 'admin@meridian.test').expect(
        200,
      );
      const header = response.headers['set-cookie'] as unknown as string[];
      const cookie = header.find((line) =>
        line.startsWith(`${REFRESH_COOKIE}=`),
      )!;

      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Path=/auth');
      expect(cookie).toContain('SameSite=Lax');
    });

    it('carries sub, tenantId, and role in a 15-minute access token', async () => {
      const { body } = await signIn(meridian, 'admin@meridian.test').expect(
        200,
      );

      const claims = decodeClaims(body.accessToken as string);

      expect(claims).toMatchObject({ tenantId: meridian, role: 'admin' });
      expect(claims.sub).toEqual(expect.any(String));
      expect(claims.exp - claims.iat).toBe(15 * 60);
    });

    /**
     * Tenant-local identity, demonstrated rather than asserted. One address,
     * two tenants, two Users — and the roles differ, so resolving the wrong
     * row would show up in the authority handed back, not only in the id.
     */
    it('resolves the same address at two tenants to two distinct Users', async () => {
      const atMeridian = await signIn(meridian, SHARED_EMAIL).expect(200);
      const atSortwood = await signIn(sortwood, SHARED_EMAIL).expect(200);

      const one = decodeClaims(atMeridian.body.accessToken as string);
      const other = decodeClaims(atSortwood.body.accessToken as string);

      expect(one.sub).not.toEqual(other.sub);
      expect(one.tenantId).toBe(meridian);
      expect(other.tenantId).toBe(sortwood);
      expect(one.role).toBe('agent');
      expect(other.role).toBe('admin');
    });

    it('refuses a wrong password', async () => {
      const response = await signIn(
        meridian,
        'admin@meridian.test',
        'not-the-password',
      ).expect(401);

      expect(response.body.error.code).toBe('unauthenticated');
    });

    /**
     * The cross-tenant refusal, which is the one that would leak membership if
     * it answered differently from a wrong password. Meridian's admin is a real
     * User with a real password — just not in Sortwood.
     */
    it('refuses a real credential quoted against the wrong tenant, indistinguishably', async () => {
      const wrongTenant = await signIn(sortwood, 'admin@meridian.test').expect(
        401,
      );

      const wrongPassword = await signIn(
        meridian,
        'admin@meridian.test',
        'not-the-password',
      ).expect(401);

      expect(wrongTenant.body).toEqual(wrongPassword.body);
    });

    it('refuses an unknown address', async () => {
      await signIn(meridian, 'nobody@meridian.test').expect(401);
    });

    /**
     * A short guess must be refused for being wrong, not for being short. A
     * minimum length on this DTO would answer 422 before any lookup ran,
     * which tells an anonymous caller something about their input that every
     * other refusal here is careful not to.
     */
    it('refuses a too-short password identically to a wrong one', async () => {
      const short = await signIn(meridian, 'admin@meridian.test', 'x').expect(
        401,
      );
      const wrong = await signIn(
        meridian,
        'admin@meridian.test',
        'not-the-password',
      ).expect(401);

      expect(short.body).toEqual(wrong.body);
    });
  });

  describe('the authenticated principal', () => {
    it('reflects the caller, read through the tenant its token armed', async () => {
      const { body } = await signIn(meridian, 'agent@meridian.test').expect(
        200,
      );

      const me = await server()
        .get('/auth/me')
        .set('Authorization', `Bearer ${body.accessToken}`)
        .expect(200);

      expect(me.body).toEqual({
        kind: 'user',
        userId: expect.any(String),
        tenantId: meridian,
        role: 'agent',
        email: 'agent@meridian.test',
        name: 'Ravi Menon',
      });
    });

    it('refuses a request with no credential', async () => {
      const response = await server().get('/auth/me').expect(401);

      expect(response.body.error.code).toBe('unauthenticated');
    });

    it.each([
      ['malformed', 'not-a-jwt'],
      ['empty', ''],
      ['a well-formed JWT signed with another key', foreignToken()],
    ])('refuses %s bearer credentials', async (_case, token) => {
      await server()
        .get('/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    });

    it('refuses an expired access token', async () => {
      await server()
        .get('/auth/me')
        .set('Authorization', `Bearer ${expiredToken()}`)
        .expect(401);
    });
  });

  describe('refreshing', () => {
    it('rotates the token and issues a new access token', async () => {
      const signedIn = await signIn(meridian, 'admin@meridian.test').expect(
        200,
      );
      const first = refreshCookie(signedIn);

      const refreshed = await server()
        .post('/auth/refresh')
        .set('Cookie', first)
        .expect(200);

      expect(refreshed.body.accessToken).toEqual(expect.any(String));

      // Rotation means the successor is a genuinely different secret, not the
      // same one re-sent with a later expiry.
      expect(refreshCookie(refreshed)).not.toEqual(first);
    });

    it('accepts the rotated successor', async () => {
      const signedIn = await signIn(meridian, 'admin@meridian.test').expect(
        200,
      );

      const refreshed = await server()
        .post('/auth/refresh')
        .set('Cookie', refreshCookie(signedIn))
        .expect(200);

      await server()
        .post('/auth/refresh')
        .set('Cookie', refreshCookie(refreshed))
        .expect(200);
    });

    /**
     * The theft response, and the reason rotation is worth its complexity.
     * Replaying a spent token evicts the family, so the successor the
     * legitimate client is holding stops working too — theft costs both
     * parties the session rather than granting the thief a parallel one.
     */
    it('revokes the whole family when a rotated token is replayed', async () => {
      const signedIn = await signIn(meridian, 'admin@meridian.test').expect(
        200,
      );
      const original = refreshCookie(signedIn);

      const refreshed = await server()
        .post('/auth/refresh')
        .set('Cookie', original)
        .expect(200);

      const successor = refreshCookie(refreshed);

      // The replay itself is refused...
      await server().post('/auth/refresh').set('Cookie', original).expect(401);

      // ...and takes the legitimate successor down with it.
      await server().post('/auth/refresh').set('Cookie', successor).expect(401);
    });

    it('clears the cookie when it refuses, so a dead token stops being sent', async () => {
      const response = await server()
        .post('/auth/refresh')
        .set('Cookie', `${REFRESH_COOKIE}=${meridian}.invented-token`)
        .expect(401);

      const header = response.headers['set-cookie'] as unknown as string[];

      expect(
        header.some((line) => line.startsWith(`${REFRESH_COOKIE}=;`)),
      ).toBe(true);
    });

    it('refuses a request with no cookie at all', async () => {
      await server().post('/auth/refresh').expect(401);
    });

    /**
     * A cookie is client-controlled input, so a malformed one is a refusal —
     * never a server error. `withTenant()` raises on a bad tenant id rather
     * than refusing, and rightly so everywhere else: there it means a call
     * site skipped the credential. Here it means somebody edited a cookie.
     */
    it.each([
      ['a non-uuid tenant', 'notauuid.sometoken'],
      ['no separator', 'notauuid'],
      ['an empty value', ''],
    ])('refuses a cookie with %s rather than failing', async (_case, value) => {
      await server()
        .post('/auth/refresh')
        .set('Cookie', `${REFRESH_COOKIE}=${value}`)
        .expect(401);
    });

    /**
     * The tenant travelling in the cookie is a routing hint, not authority. A
     * real token quoted against another tenant finds no row there, because
     * row-level security scopes the lookup — so it is refused exactly like an
     * invented one.
     */
    it('refuses a real token quoted against the wrong tenant', async () => {
      const signedIn = await signIn(meridian, 'admin@meridian.test').expect(
        200,
      );
      const token = refreshCookie(signedIn).split('.').slice(1).join('.');

      await server()
        .post('/auth/refresh')
        .set('Cookie', `${REFRESH_COOKIE}=${sortwood}.${token}`)
        .expect(401);

      // And the original still works — a failed probe must not evict anything.
      await server()
        .post('/auth/refresh')
        .set('Cookie', refreshCookie(signedIn))
        .expect(200);
    });
  });

  /**
   * The storage half of the ticket's promise, asserted where it actually
   * lives. Every test above would pass just as happily against a table full of
   * plaintext tokens — only reading the row proves otherwise.
   *
   * Read as the owner, from outside the policy system, for the same reason
   * `seededTenantIds` does: the point is that the raw value is absent from the
   * table *at all*, and a tenant-scoped read could only speak for one tenant's
   * rows.
   */
  describe('how refresh tokens are stored', () => {
    it('keeps only a hash — the raw token appears nowhere in the table', async () => {
      const signedIn = await signIn(meridian, 'admin@meridian.test').expect(
        200,
      );
      const raw = refreshCookie(signedIn).split('.').slice(1).join('.');

      const client = new Client({
        connectionString: process.env['MIGRATE_DATABASE_URL'],
      });
      await client.connect();

      try {
        const { rows } = await client.query<{ token_hash: string }>(
          'SELECT token_hash FROM refresh_token WHERE token_hash = $1',
          [createHash('sha256').update(raw).digest('hex')],
        );

        // The hash is there, so this is looking at the right row...
        expect(rows).toHaveLength(1);

        // ...and the usable value is not, anywhere.
        const { rows: leaked } = await client.query<{ count: string }>(
          'SELECT count(*)::text FROM refresh_token WHERE token_hash = $1',
          [raw],
        );

        expect(leaked[0].count).toBe('0');
      } finally {
        await client.end();
      }
    });
  });

  describe('signing out', () => {
    it('revokes the family, so the refresh token stops working', async () => {
      const signedIn = await signIn(meridian, 'admin@meridian.test').expect(
        200,
      );
      const cookie = refreshCookie(signedIn);

      await server().post('/auth/sign-out').set('Cookie', cookie).expect(204);
      await server().post('/auth/refresh').set('Cookie', cookie).expect(401);
    });

    it('succeeds without a cookie, rather than reporting whether one existed', async () => {
      await server().post('/auth/sign-out').expect(204);
    });

    it('stays idempotent in the face of a malformed cookie', async () => {
      await server()
        .post('/auth/sign-out')
        .set('Cookie', `${REFRESH_COOKIE}=notauuid.sometoken`)
        .expect(204);
    });
  });
});

/**
 * Function declarations rather than arrow constants, deliberately: `it.each`
 * evaluates its table while the `describe` body runs, which is before any
 * `const` below it is initialized. Hoisting is what lets the helpers stay at
 * the bottom where they do not crowd out the assertions.
 */
interface Claims {
  sub: string;
  tenantId: string;
  role: string;
  iat: number;
  exp: number;
}

/**
 * Reads a JWT's payload without verifying it.
 *
 * Appropriate precisely here and nowhere in `src`: the test is asserting what
 * claims the server put in the token, and verifying the signature first would
 * only re-test what the server just did.
 */
function decodeClaims(token: string): Claims {
  return JSON.parse(
    Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
  ) as Claims;
}

/** A structurally perfect token, signed with a key this server does not hold. */
function foreignToken(): string {
  return signHs256(
    {
      sub: 'someone',
      tenantId: 'somewhere',
      role: 'admin',
      iss: 'nivara-desk',
      aud: 'nivara-api',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
    },
    'a-key-this-server-has-never-seen-and-never-will',
  );
}

/** Correctly signed, and past its expiry — the ordinary end of a session. */
function expiredToken(): string {
  return signHs256(
    {
      sub: 'someone',
      tenantId: 'somewhere',
      role: 'admin',
      iss: 'nivara-desk',
      aud: 'nivara-api',
      iat: Math.floor(Date.now() / 1000) - 7200,
      exp: Math.floor(Date.now() / 1000) - 3600,
    },
    process.env['JWT_SECRET']!,
  );
}

function signHs256(payload: object, secret: string): string {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');

  const body = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}`;
  const signature = createHmac('sha256', secret)
    .update(body)
    .digest('base64url');

  return `${body}.${signature}`;
}
