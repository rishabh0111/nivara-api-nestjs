import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { asOwner, contactOf } from './helpers/as-owner';
import { bootApp } from './helpers/boot';
import { seededTenantIds } from './helpers/seeded-tenants';

/**
 * Service tokens, end to end and against a real database.
 *
 * Almost everything here needs a real request path rather than a unit test,
 * because the claims are about *sharing*: that a machine credential reaches the
 * same authorization guard staff do, arms the same row-level security, and is
 * attributed by the same trigger. A mock would prove the double, not the
 * design. The two pieces that are pure — the token format and the scope
 * vocabulary — are covered next to their source instead.
 *
 * The claim this file exists for above all others is revocation with no delay.
 * It is a statement about there being no cache in the authentication path, and
 * the only way to make it is to revoke a token and immediately use it.
 *
 * Requires `docker compose up -d postgres && npm run db:migrate && npm run
 * db:seed`; see `npm run test:int`.
 */

const PASSWORD = 'nivara-demo-password';

/** Stamped on everything this suite writes, so cleanup can find it all. */
const MARK = 'service-tokens-int-spec';

describe('service tokens', () => {
  let app: INestApplication;
  let meridian: string;
  let sortwood: string;
  let adminToken: string;
  let agentToken: string;
  let contactId: string;

  beforeAll(async () => {
    app = await bootApp();
    ({ meridian, sortwood } = await seededTenantIds());

    adminToken = await staffToken(meridian, 'admin@meridian.test');
    agentToken = await staffToken(meridian, 'agent@meridian.test');
    contactId = await contactOf(meridian, 'jules@example.test');
  });

  afterAll(async () => {
    await app?.close();
    await asOwner(`DELETE FROM ticket WHERE subject LIKE '${MARK}%'`);
    // The token rows go; their `token.minted` and `token.revoked` audit rows
    // stay, and deliberately so. `audit_log` refuses DELETE to *everyone*,
    // including the owner this connection is — history outliving the thing it
    // describes is the guarantee, not a cleanup gap. It is also why the target
    // is a plain column rather than a foreign key: nothing here needs the
    // referent to still exist.
    await asOwner(`DELETE FROM service_token WHERE name LIKE '${MARK}%'`);
  });

  const server = () => request(app.getHttpServer());

  const staffToken = async (
    tenantId: string,
    email: string,
  ): Promise<string> => {
    const { body } = await server()
      .post('/auth/sign-in')
      .send({ tenantId, email, password: PASSWORD })
      .expect(200);

    return body.accessToken as string;
  };

  const as = (token: string) => ({
    get: (path: string) =>
      server().get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) =>
      server().post(path).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object = {}) =>
      server().patch(path).set('Authorization', `Bearer ${token}`).send(body),
    delete: (path: string) =>
      server().delete(path).set('Authorization', `Bearer ${token}`),
  });

  /** Mints a token with the given scopes and hands back the raw credential. */
  const mint = async (
    scopes: string[],
    token = adminToken,
  ): Promise<{ raw: string; id: string }> => {
    const { body } = await as(token)
      .post('/service-tokens', { name: `${MARK} ${randomUUID()}`, scopes })
      .expect(201);

    return { raw: body.token as string, id: body.id as string };
  };

  const openTicket = async (): Promise<string> => {
    const { body } = await as(agentToken)
      .post('/tickets', {
        subject: `${MARK} ${randomUUID()}`,
        contactId,
        source: 'portal',
      })
      .expect(201);

    return body.id as string;
  };

  // -------------------------------------------------------------------------
  // Minting
  // -------------------------------------------------------------------------

  describe('minting', () => {
    it('returns the raw credential exactly once, and stores only a hash', async () => {
      const { body } = await as(adminToken)
        .post('/service-tokens', {
          name: `${MARK} triage assistant`,
          scopes: ['ticket:read', 'ticket:reply'],
        })
        .expect(201);

      expect(body.token).toEqual(expect.stringContaining('nvk_live_'));

      // The row holds a hash, and it is not the token. This is the whole
      // "database access does not yield usable credentials" claim, checked
      // from outside the application rather than taken on trust.
      const [row] = await asOwner<{ token_hash: string }>(
        'SELECT token_hash FROM service_token WHERE id = $1',
        [body.id],
      );

      expect(row.token_hash).not.toBe(body.token);
      expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);

      // And it is unrecoverable: no later read offers it back.
      const listed = await as(adminToken).get('/service-tokens').expect(200);
      const mine = listed.body.find((t: { id: string }) => t.id === body.id);

      expect(mine).toBeDefined();
      expect(mine.token).toBeUndefined();
      expect(JSON.stringify(listed.body)).not.toContain(body.token);
    });

    /**
     * Provenance is stamped, not accepted — asserted from both sides, because
     * either alone would be weak evidence.
     */
    it('stamps tenant and creator from the credential', async () => {
      const { body } = await as(adminToken)
        .post('/service-tokens', {
          name: `${MARK} provenance`,
          scopes: ['ticket:read'],
        })
        .expect(201);

      const [row] = await asOwner<{ tenant_id: string; created_by_id: string }>(
        'SELECT tenant_id::text, created_by_id::text FROM service_token WHERE id = $1',
        [body.id],
      );

      expect(row.tenant_id).toBe(meridian);
      expect(row.tenant_id).not.toBe(sortwood);

      const [admin] = await asOwner<{ id: string }>(
        `SELECT id::text FROM "user" WHERE tenant_id = $1 AND email = 'admin@meridian.test'`,
        [meridian],
      );

      expect(row.created_by_id).toBe(admin.id);
    });

    /**
     * The other side: there is no field in which to try. The DTO declares only
     * `name` and `scopes`, and the global pipe refuses undeclared properties —
     * so an attempt to name a tenant or a creator is rejected outright rather
     * than silently ignored. Rejection is the better answer of the two: a
     * caller who believes they set the tenant should be told they did not.
     */
    it('has no field in which to assert a tenant or a creator', async () => {
      for (const forged of [
        { tenantId: sortwood },
        { createdById: randomUUID() },
      ]) {
        const response = await as(adminToken)
          .post('/service-tokens', {
            name: `${MARK} forged provenance`,
            scopes: ['ticket:read'],
            ...forged,
          })
          .expect(422);

        expect(response.body.error.code).toBe('validation_failed');
      }
    });

    it('is refused to an agent, who does not hold token:manage', async () => {
      const response = await as(agentToken)
        .post('/service-tokens', {
          name: `${MARK} unauthorized`,
          scopes: ['ticket:read'],
        })
        .expect(403);

      expect(response.body.error.code).toBe('forbidden');
    });

    /** The ticket's un-grantable classes, each checked at the real endpoint. */
    it.each([
      ['audit-read', 'audit:read'],
      ['destructive', 'ticket:delete'],
      ['terminal', 'ticket:close'],
      ['configuration', 'sla:configure'],
      ['user-management', 'user:invite'],
      ['token-management', 'token:manage'],
    ])('refuses a %s scope', async (_class, scope) => {
      const response = await as(adminToken)
        .post('/service-tokens', {
          name: `${MARK} forbidden scope`,
          scopes: ['ticket:read', scope],
        })
        .expect(422);

      expect(response.body.error.code).toBe('validation_failed');
      expect(response.body.error.message).toContain(scope);
    });

    it('refuses a scope outside the vocabulary', async () => {
      await as(adminToken)
        .post('/service-tokens', {
          name: `${MARK} nonsense scope`,
          scopes: ['ticket:obliterate'],
        })
        .expect(422);
    });

    it('refuses a token with no scopes at all', async () => {
      await as(adminToken)
        .post('/service-tokens', { name: `${MARK} empty`, scopes: [] })
        .expect(422);
    });
  });

  // -------------------------------------------------------------------------
  // Authenticating
  // -------------------------------------------------------------------------

  describe('authenticating', () => {
    it('carries exactly its scopes through the shared authorization path', async () => {
      const { raw } = await mint(['ticket:read']);
      const ticketId = await openTicket();

      // Granted: the same endpoint, the same guard, the same policies staff hit.
      await as(raw).get(`/tickets/${ticketId}`).expect(200);

      // Not granted, and refused by the guard rather than by a check written
      // anywhere in the service-token code — `ticket:priority` is simply absent
      // from the set `permissionsFor()` answered.
      await as(raw)
        .patch(`/tickets/${ticketId}/priority`, { priority: 'urgent' })
        .expect(403);
    });

    it('is refused when the credential is unknown', async () => {
      const response = await as(`nvk_live_${meridian}.not-a-real-secret`)
        .get('/tickets')
        .expect(401);

      expect(response.body.error.code).toBe('unauthenticated');
    });

    /**
     * The routing segment is a hint, not a claim. The hash covers it, so a real
     * token relabelled with another tenant's id matches no row anywhere — it
     * does not become a Sortwood credential, and it does not stay a Meridian
     * one either.
     */
    it('is refused when the tenant segment is edited', async () => {
      const { raw } = await mint(['ticket:read']);
      const relabelled = raw.replace(meridian, sortwood);

      expect(relabelled).not.toBe(raw);
      await as(relabelled).get('/tickets').expect(401);
    });

    it('sees only its own tenant’s rows', async () => {
      const { raw } = await mint(['ticket:read']);
      const ours = await openTicket();

      const [theirs] = await asOwner<{ id: string }>(
        'SELECT id::text FROM ticket WHERE tenant_id = $1 LIMIT 1',
        [sortwood],
      );

      await as(raw).get(`/tickets/${ours}`).expect(200);
      // 404 rather than 403: row-level security makes the row invisible, so
      // there is nothing here that could tell "not yours" from "not there".
      if (theirs) await as(raw).get(`/tickets/${theirs.id}`).expect(404);
    });

    /**
     * The read-side narrowing, demonstrated where it actually bites: a scope
     * written to the column outside the mint path. `audit:read` gets into the
     * row by raw SQL — the migration, support-script and other-language-port
     * case `grantedScopes` exists for — and it confers nothing, and is not
     * reported as though it did.
     */
    it('confers nothing from a forbidden scope written straight to the row', async () => {
      const { raw, id } = await mint(['ticket:read']);

      await asOwner(
        `UPDATE service_token SET scopes = ARRAY['ticket:read','audit:read'] WHERE id = $1`,
        [id],
      );

      const ticketId = await openTicket();

      // Still authenticates, and still holds what it was really granted.
      await as(raw).get(`/tickets/${ticketId}`).expect(200);
      // The smuggled scope confers nothing.
      await as(raw).get(`/tickets/${ticketId}/audit`).expect(403);

      // And the admin's view reports effective authority rather than the raw
      // column, so the display cannot claim more than the token can do.
      const listed = await as(adminToken).get('/service-tokens').expect(200);
      const mine = listed.body.find((t: { id: string }) => t.id === id);

      expect(mine.scopes).toEqual(['ticket:read']);
    });
  });

  // -------------------------------------------------------------------------
  // Separable reply and note authority — the suggest-only mode
  // -------------------------------------------------------------------------

  describe('reply and note authority', () => {
    it('replies but writes no Note when granted ticket:reply alone', async () => {
      const { raw } = await mint(['ticket:read', 'ticket:reply']);
      const ticketId = await openTicket();

      await as(raw)
        .post(`/tickets/${ticketId}/messages`, { body: 'A drafted reply.' })
        .expect(201);

      await as(raw)
        .post(`/tickets/${ticketId}/notes`, { body: 'An internal thought.' })
        .expect(403);
    });

    /**
     * The reverse, and the more interesting half: suggest-only. An AI layer
     * that drafts internally and never speaks to a customer is one scope list
     * away, with no mode flag anywhere in the code.
     */
    it('writes Notes but cannot reply when granted note:write alone', async () => {
      const { raw } = await mint(['ticket:read', 'note:read', 'note:write']);
      const ticketId = await openTicket();

      await as(raw)
        .post(`/tickets/${ticketId}/notes`, { body: 'A suggested reply.' })
        .expect(201);

      await as(raw)
        .post(`/tickets/${ticketId}/messages`, { body: 'Speaking directly.' })
        .expect(403);
    });
  });

  // -------------------------------------------------------------------------
  // The audit log is out of reach
  // -------------------------------------------------------------------------

  describe('the audit log', () => {
    /**
     * `audit:read` is un-grantable, so this is refused at the guard for the
     * plainest possible reason: no scope list containing it can exist.
     */
    it('cannot be read by a service token', async () => {
      const { raw } = await mint(['ticket:read']);
      const ticketId = await openTicket();

      await as(raw).get(`/tickets/${ticketId}/audit`).expect(403);
      // The staff path works, so the refusal above is authority and not a
      // missing route.
      await as(adminToken).get(`/tickets/${ticketId}/audit`).expect(200);
    });
  });

  // -------------------------------------------------------------------------
  // Attribution
  // -------------------------------------------------------------------------

  describe('attribution', () => {
    /**
     * The point of the whole feature, from the analytics side: AI contribution
     * is measurable because a machine-authored Message is a different row from a
     * human-authored one, not a flag on the same shape. Read from the columns
     * rather than the response, because the trigger is what stamps them.
     */
    it('marks Messages and Notes authored by a token distinctly from a User’s', async () => {
      const { raw, id: tokenId } = await mint([
        'ticket:read',
        'ticket:reply',
        'note:read',
        'note:write',
      ]);
      const ticketId = await openTicket();

      await as(raw)
        .post(`/tickets/${ticketId}/messages`, { body: 'From the machine.' })
        .expect(201);
      await as(agentToken)
        .post(`/tickets/${ticketId}/messages`, { body: 'From a person.' })
        .expect(201);
      await as(raw)
        .post(`/tickets/${ticketId}/notes`, { body: 'Machine note.' })
        .expect(201);

      const messages = await asOwner<{
        author_kind: string;
        author_id: string;
        body: string;
      }>(
        'SELECT author_kind::text, author_id::text, body FROM message WHERE ticket_id = $1 ORDER BY created_at',
        [ticketId],
      );

      const machine = messages.find((m) => m.body === 'From the machine.');
      const human = messages.find((m) => m.body === 'From a person.');

      expect(machine?.author_kind).toBe('service');
      expect(machine?.author_id).toBe(tokenId);
      expect(human?.author_kind).toBe('user');
      expect(human?.author_id).not.toBe(tokenId);

      const [note] = await asOwner<{ author_kind: string; author_id: string }>(
        'SELECT author_kind::text, author_id::text FROM note WHERE ticket_id = $1',
        [ticketId],
      );

      expect(note.author_kind).toBe('service');
      expect(note.author_id).toBe(tokenId);
    });
  });

  // -------------------------------------------------------------------------
  // Revocation
  // -------------------------------------------------------------------------

  describe('revocation', () => {
    /**
     * The claim the whole stateful design is bought for. No sleep, no cache
     * warm-up, no second request to let a TTL lapse: the call that works and
     * the call that does not are adjacent.
     */
    it('takes effect on the very next request', async () => {
      const { raw, id } = await mint(['ticket:read']);

      await as(raw).get('/tickets').expect(200);
      await as(adminToken).delete(`/service-tokens/${id}`).expect(204);

      const response = await as(raw).get('/tickets').expect(401);

      expect(response.body.error.code).toBe('unauthenticated');
    });

    it('is final — a revoked token cannot be revoked back into life', async () => {
      const { id } = await mint(['ticket:read']);

      await as(adminToken).delete(`/service-tokens/${id}`).expect(204);

      const response = await as(adminToken)
        .delete(`/service-tokens/${id}`)
        .expect(409);

      expect(response.body.error.code).toBe('conflict');
    });

    it('keeps the revoked row, so the audit trail still has a target', async () => {
      const { id } = await mint(['ticket:read']);

      await as(adminToken).delete(`/service-tokens/${id}`).expect(204);

      const listed = await as(adminToken).get('/service-tokens').expect(200);
      const mine = listed.body.find((t: { id: string }) => t.id === id);

      expect(mine.revokedAt).toEqual(expect.any(String));
    });

    it('answers 404 for a token in another tenant', async () => {
      const { id } = await mint(['ticket:read']);
      const sortwoodAdmin = await staffToken(sortwood, 'admin@sortwood.test');

      await as(sortwoodAdmin).delete(`/service-tokens/${id}`).expect(404);
    });
  });

  // -------------------------------------------------------------------------
  // The audit rows minting and revoking leave behind
  // -------------------------------------------------------------------------

  describe('audit rows', () => {
    it('records token.minted and token.revoked against the minting admin', async () => {
      const { id } = await mint(['ticket:read', 'ticket:reply']);
      await as(adminToken).delete(`/service-tokens/${id}`).expect(204);

      const rows = await asOwner<{
        action: string;
        actor_kind: string;
        actor_id: string;
        metadata: { name?: string; scopes?: string[] };
      }>(
        `SELECT action::text, actor_kind::text, actor_id::text, metadata
           FROM audit_log WHERE target_id = $1 ORDER BY created_at`,
        [id],
      );

      expect(rows.map((r) => r.action)).toEqual([
        'token.minted',
        'token.revoked',
      ]);

      // Attributed to the admin who acted, not to the token they created —
      // minting is a human act on a machine credential.
      for (const row of rows) {
        expect(row.actor_kind).toBe('user');
      }

      expect(rows[0].metadata.scopes).toEqual(['ticket:read', 'ticket:reply']);
    });

    /**
     * A rolled-back mint must leave neither a credential nor a claim that one
     * was issued. The refused scope is what rolls it back.
     */
    it('writes no row for a mint that was refused', async () => {
      const name = `${MARK} refused ${randomUUID()}`;

      await as(adminToken)
        .post('/service-tokens', { name, scopes: ['audit:read'] })
        .expect(422);

      const rows = await asOwner<{ id: string }>(
        'SELECT id::text FROM service_token WHERE name = $1',
        [name],
      );

      expect(rows).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // The published scope list
  // -------------------------------------------------------------------------

  describe('the assignable scope list', () => {
    it('publishes what may be granted, with descriptions', async () => {
      const { body } = await as(adminToken)
        .get('/service-tokens/scopes')
        .expect(200);

      const names = body.scopes.map((s: { scope: string }) => s.scope);

      expect(names).toContain('ticket:reply');
      expect(names).toContain('note:write');
      expect(names).not.toContain('audit:read');
      expect(names).not.toContain('token:manage');

      for (const entry of body.scopes) {
        expect(entry.description).toEqual(expect.any(String));
      }
    });

    /**
     * The list is the contract the mint endpoint honours. Asserted by minting
     * with every scope it publishes at once, so a name that appears here but is
     * refused there would fail rather than merely mislead the tooling reading
     * it.
     */
    it('publishes exactly the scopes minting accepts', async () => {
      const { body } = await as(adminToken)
        .get('/service-tokens/scopes')
        .expect(200);

      const all = body.scopes.map((s: { scope: string }) => s.scope);
      const minted = await as(adminToken)
        .post('/service-tokens', { name: `${MARK} every scope`, scopes: all })
        .expect(201);

      expect(minted.body.scopes.sort()).toEqual([...all].sort());
    });

    it('is not reachable by a service token', async () => {
      const { raw } = await mint(['ticket:read']);

      await as(raw).get('/service-tokens/scopes').expect(403);
    });

    /**
     * The containment property worth stating on its own: a token cannot mint
     * its successor, so revoking it really does end the machine's access.
     */
    it('does not let a service token mint another token', async () => {
      const { raw } = await mint(['ticket:read']);

      await as(raw)
        .post('/service-tokens', {
          name: `${MARK} successor`,
          scopes: ['ticket:read'],
        })
        .expect(403);
    });
  });
});
