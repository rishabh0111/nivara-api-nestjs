import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { asOwner } from './helpers/as-owner';
import { bootApp } from './helpers/boot';
import { seededTenantIds } from './helpers/seeded-tenants';

/**
 * Authorization, end to end and against a real database.
 *
 * The claims worth making here are all about wiring — that the permission
 * guard runs after authentication on every route, that a role map decides the
 * verdict, that a refused caller is refused before the handler touches the
 * database. None of them survive being unit-tested: the guard's decision is
 * covered in `src/authz/permission.guard.spec.ts`, and what remains is whether
 * that decision is actually in the request path.
 *
 * Requires `docker compose up -d postgres && npm run db:migrate && npm run
 * db:seed`; see `npm run test:int`.
 */

const PASSWORD = 'nivara-demo-password';

describe('authorization', () => {
  let app: INestApplication;
  let meridian: string;
  let sortwood: string;
  let adminToken: string;
  let agentToken: string;

  beforeAll(async () => {
    app = await bootApp();
    ({ meridian, sortwood } = await seededTenantIds());
    adminToken = await tokenFor(meridian, 'admin@meridian.test');
    agentToken = await tokenFor(meridian, 'agent@meridian.test');
  });

  afterAll(async () => {
    await app?.close();
    await cleanUpInvitees();
  });

  const server = () => request(app.getHttpServer());

  const tokenFor = async (
    tenantId: string,
    email: string,
    password = PASSWORD,
  ): Promise<string> => {
    const { body } = await server()
      .post('/auth/sign-in')
      .send({ tenantId, email, password })
      .expect(200);

    return body.accessToken as string;
  };

  /** A fresh address per test, so re-running the suite is not a conflict. */
  const newEmail = () => `invitee-${randomUUID()}@meridian.test`;

  const invite = (token: string | null, email = newEmail()) => {
    const call = server()
      .post('/staff/invitations')
      .send({ email, name: 'Nadia Farouk', role: 'agent' });

    return token ? call.set('Authorization', `Bearer ${token}`) : call;
  };

  describe('a permission-gated operation', () => {
    it('is allowed to a principal holding the permission', async () => {
      const email = newEmail();
      const response = await invite(adminToken, email).expect(201);

      expect(response.body).toEqual({
        id: expect.any(String),
        userId: expect.any(String),
        email,
        role: 'agent',
        token: expect.any(String),
        expiresAt: expect.any(String),
      });
    });

    /**
     * The refusal the ticket exists for. `user:invite` is admin-only, and an
     * agent is a fully authenticated caller — so this is authorization
     * failing, not authentication, and the status has to say so.
     */
    it('is refused to an authenticated principal without it', async () => {
      const response = await invite(agentToken).expect(403);

      expect(response.body.error.code).toBe('forbidden');
      expect(response.body.error.message).toEqual(expect.any(String));
    });

    /**
     * Guard order, asserted where it can actually break. A permission guard
     * that ran *before* authentication would answer 403 here — or worse, throw
     * on a principal that is not there yet.
     */
    it('answers unauthenticated, not forbidden, with no credential at all', async () => {
      const response = await invite(null).expect(401);

      expect(response.body.error.code).toBe('unauthenticated');
    });

    /**
     * Refusal happens before the handler runs, so nothing is written. Asserted
     * by trying the same address again as an admin: a partial write on the
     * refused call would surface here as a conflict.
     */
    it('writes nothing when it refuses', async () => {
      const email = newEmail();

      await invite(agentToken, email).expect(403);
      await invite(adminToken, email).expect(201);
    });
  });

  describe('an operation requiring only authentication', () => {
    it('is allowed to any authenticated principal, whatever their role', async () => {
      for (const token of [adminToken, agentToken]) {
        await server()
          .get('/auth/me')
          .set('Authorization', `Bearer ${token}`)
          .expect(200);
      }
    });
  });

  describe('provisioning a staff member by invitation', () => {
    it('creates a User who cannot sign in until they accept', async () => {
      const email = newEmail();
      const { body } = await invite(adminToken, email).expect(201);

      // Membership precedes credentials: the User exists, with no password to
      // compare against, so a sign-in attempt is refused like any other.
      await server()
        .post('/auth/sign-in')
        .send({ tenantId: meridian, email, password: 'anything-at-all' })
        .expect(401);

      await server()
        .post('/staff/invitations/accept')
        .send({
          tenantId: meridian,
          token: body.token,
          password: 'a-brand-new-password',
        })
        .expect(204);

      const signedIn = await server()
        .post('/auth/sign-in')
        .send({ tenantId: meridian, email, password: 'a-brand-new-password' })
        .expect(200);

      expect(signedIn.body.accessToken).toEqual(expect.any(String));
    });

    it('grants exactly the role the admin chose, not one the invitee picks', async () => {
      const email = newEmail();
      const { body } = await server()
        .post('/staff/invitations')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ email, name: 'Nadia Farouk', role: 'agent' })
        .expect(201);

      await server()
        .post('/staff/invitations/accept')
        .send({
          tenantId: meridian,
          token: body.token,
          password: 'a-brand-new-password',
        })
        .expect(204);

      // The invitee inherits agent authority, so the door they came through is
      // one they cannot themselves open.
      const invitee = await tokenFor(meridian, email, 'a-brand-new-password');

      await server()
        .post('/staff/invitations')
        .set('Authorization', `Bearer ${invitee}`)
        .send({ email: newEmail(), name: 'Someone Else', role: 'admin' })
        .expect(403);
    });

    it('refuses to invite an address that is already a member', async () => {
      const response = await invite(adminToken, 'agent@meridian.test').expect(
        409,
      );

      expect(response.body.error.code).toBe('conflict');
    });

    /**
     * Tenant-local identity again: an address that exists at Sortwood is not a
     * member here, so Meridian's admin may invite it. The lookup runs inside
     * the admin's own context and can see no further.
     */
    it('allows inviting an address that belongs to another tenant', async () => {
      await invite(adminToken, 'admin@sortwood.test').expect(201);
    });

    it('is single-use — the same token cannot be accepted twice', async () => {
      const { body } = await invite(adminToken).expect(201);

      const accept = () =>
        server().post('/staff/invitations/accept').send({
          tenantId: meridian,
          token: body.token,
          password: 'a-brand-new-password',
        });

      await accept().expect(204);
      await accept().expect(401);
    });

    /**
     * The token is a lookup key inside an armed context, so quoting it against
     * another tenant finds no row — the same shape of refusal a stolen refresh
     * token gets.
     */
    it('refuses a real token quoted against the wrong tenant', async () => {
      const { body } = await invite(adminToken).expect(201);

      await server()
        .post('/staff/invitations/accept')
        .send({
          tenantId: sortwood,
          token: body.token,
          password: 'a-brand-new-password',
        })
        .expect(401);
    });

    it('refuses an unknown token indistinguishably from a spent one', async () => {
      await server()
        .post('/staff/invitations/accept')
        .send({
          tenantId: meridian,
          token: 'not-an-invitation-anyone-issued',
          password: 'a-brand-new-password',
        })
        .expect(401);
    });

    /**
     * A floor on the password here, unlike on sign-in. This is where a
     * password is chosen, so refusing a short one is help rather than an
     * oracle — and 422 is the honest status for input the caller can fix.
     */
    it('refuses a password too short to be worth having', async () => {
      const { body } = await invite(adminToken).expect(201);

      const response = await server()
        .post('/staff/invitations/accept')
        .send({ tenantId: meridian, token: body.token, password: 'short' })
        .expect(422);

      expect(response.body.error.code).toBe('validation_failed');
    });
  });

  /**
   * The storage half of the promise, asserted where it lives. Every test above
   * would pass against a table full of plaintext invitations.
   *
   * Read as the owner for the reason `seededTenantIds` gives: the claim is
   * that the raw value is absent from the table *at all*.
   */
  describe('how invitations are stored', () => {
    it('keeps only a hash — the raw token appears nowhere in the table', async () => {
      const { body } = await invite(adminToken).expect(201);

      const rows = await asOwner<{ count: string }>(
        'SELECT count(*)::text FROM staff_invitation WHERE token_hash = $1',
        [body.token],
      );

      expect(rows[0].count).toBe('0');
    });
  });
});

/**
 * Removes the Users these tests invited.
 *
 * They are real rows in a shared development database, and a suite that leaves
 * a growing pile of `invitee-*` staff behind makes the seeded tenant
 * progressively less like the thing it is meant to demonstrate.
 */
async function cleanUpInvitees(): Promise<void> {
  await asOwner(
    "DELETE FROM \"user\" WHERE email LIKE 'invitee-%@meridian.test' OR (email = 'admin@sortwood.test' AND tenant_id = (SELECT id FROM tenant WHERE slug = 'meridian'))",
    [],
  );
}
