import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { IdempotencyRetentionSweep } from 'src/idempotency/idempotency-retention.sweep';
import { IdempotencyService } from 'src/idempotency/idempotency.service';
import { requestFingerprint } from 'src/idempotency/request-fingerprint';
import { asOwner, contactOf, userOf } from './helpers/as-owner';
import { bootApp } from './helpers/boot';
import { seededTenantIds } from './helpers/seeded-tenants';

/**
 * Safe retries, against a real database.
 *
 * Every claim this feature makes is about what happens between two *separate*
 * transactions, so there is very little here a unit test could reach. The
 * arbiter of a duplicate is a unique index; the thing a replay reads is a
 * committed row; the thing that survives a restart is Postgres. A double would
 * be asserting that the double works.
 *
 * The suite is written around the one failure that actually costs a customer
 * money — a retry that runs the effect twice — so nearly every test counts the
 * *Tickets* rather than only reading the status code. A 201 that looks like a
 * replay but opened a second Ticket would pass a status assertion happily.
 *
 * Requires `docker compose up -d postgres && npm run db:migrate && npm run
 * db:seed`; see `npm run test:int`.
 */

const PASSWORD = 'nivara-demo-password';

/** Stamped on everything this suite writes, so cleanup can find it all. */
const MARK = 'idempotency-int-spec';

interface RecordRow {
  scope: string;
  key: string;
  status: string;
  response_code: number | null;
  actor_kind: string;
  expires_at: Date;
}

describe('idempotency', () => {
  let app: INestApplication;
  let meridian: string;
  let sortwood: string;
  let agentToken: string;
  let adminToken: string;
  let agentId: string;
  let contactId: string;

  beforeAll(async () => {
    app = await bootApp();
    ({ meridian, sortwood } = await seededTenantIds());

    agentToken = await staffToken(meridian, 'agent@meridian.test');
    adminToken = await staffToken(meridian, 'admin@meridian.test');
    agentId = await userOf(meridian, 'agent@meridian.test');
    contactId = await contactOf(meridian, 'jules@example.test');
  });

  afterEach(async () => {
    await asOwner(`DELETE FROM ticket WHERE subject LIKE '${MARK}%'`);
    await asOwner(`DELETE FROM idempotency_record WHERE key LIKE '${MARK}%'`);
  });

  afterAll(async () => {
    await app?.close();
  });

  const server = () => request(app.getHttpServer());

  const openTicket = (
    key: string | null,
    subject: string,
    token = agentToken,
  ) => {
    const call = server()
      .post('/tickets')
      .set('Authorization', `Bearer ${token}`);

    if (key !== null) call.set('Idempotency-Key', key);

    return call.send({ subject, contactId, source: 'portal' });
  };

  const ticketsMarked = (subject: string) =>
    asOwner<{ id: string }>('SELECT id::text FROM ticket WHERE subject = $1', [
      subject,
    ]);

  const recordsFor = (key: string) =>
    asOwner<RecordRow>(
      'SELECT scope, key, status, response_code, actor_kind::text, expires_at FROM idempotency_record WHERE key = $1',
      [key],
    );

  describe('the record', () => {
    it('is written once per tenant, scope and key, first-writer-wins', async () => {
      const key = `${MARK}-once-${randomUUID()}`;
      const subject = `${MARK} first writer`;

      await openTicket(key, subject).expect(201);
      await openTicket(key, subject).expect(201);

      const rows = await recordsFor(key);

      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('completed');
      expect(rows[0].response_code).toBe(201);
      // The principal is inside the scope, not beside it — that is what stops
      // one caller reading back another's cached response.
      expect(rows[0].scope).toBe(`u:${agentId}|POST /tickets`);
      expect(rows[0].actor_kind).toBe('user');
    });

    it('survives a burst of simultaneous duplicates with one effect', async () => {
      // The genuine race, rather than a simulated one. Six requests, no
      // ordering, and the only arbiter in play is the unique index — nothing in
      // the process can see this contention, because each attempt is in its own
      // transaction by construction.
      const key = `${MARK}-burst-${randomUUID()}`;
      const subject = `${MARK} burst`;

      const responses = await Promise.all(
        Array.from({ length: 6 }, () => openTicket(key, subject)),
      );

      // Whichever attempts lost the race are 201 replays or 409s depending on
      // whether the winner had finished — both are correct, and which one a
      // given attempt sees is genuinely timing. What must never vary is this:
      expect(await ticketsMarked(subject)).toHaveLength(1);

      for (const response of responses) {
        expect([201, 409]).toContain(response.status);
      }
      expect(responses.some((r) => r.status === 201)).toBe(true);
    });
  });

  describe('replay', () => {
    it('returns the original response without executing the effect again', async () => {
      const key = `${MARK}-replay-${randomUUID()}`;
      const subject = `${MARK} replay`;

      const original = await openTicket(key, subject).expect(201);
      const replayed = await openTicket(key, subject).expect(201);

      expect(replayed.body).toEqual(original.body);
      // The assertion that matters. Equal bodies would also be produced by a
      // second create that happened to look the same.
      expect(await ticketsMarked(subject)).toHaveLength(1);
    });

    it('reproduces the stored status rather than the route’s default', async () => {
      // The stored code is deliberately *not* 201 here. Every guarded POST
      // today answers 201, which is also the status Nest stamps on a POST before
      // interceptors run — so a replay that ignored the stored code entirely
      // would pass a 201 assertion by pure coincidence. Staging a 202 is what
      // makes this test discriminate, and it is the regression alarm for the
      // `RouterExecutionContext` internal the replay path depends on.
      const key = `${MARK}-status-${randomUUID()}`;
      const subject = `${MARK} status`;

      await asOwner(
        `INSERT INTO idempotency_record
           (id, tenant_id, scope, key, request_hash, status, response_code, response_body, actor_kind, actor_id)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'completed', 202, $5, 'user', $6)`,
        [
          meridian,
          `u:${agentId}|POST /tickets`,
          key,
          requestFingerprint({ subject, contactId, source: 'portal' }),
          JSON.stringify({ accepted: true }),
          agentId,
        ],
      );

      const replayed = await openTicket(key, subject);

      expect(replayed.status).toBe(202);
      expect(replayed.body).toEqual({ accepted: true });
      expect(replayed.headers['idempotency-replayed']).toBe('true');
      // And the effect really was skipped, not merely re-answered.
      expect(await ticketsMarked(subject)).toHaveLength(0);
    });

    it('marks a replayed response so a client can tell', async () => {
      const key = `${MARK}-marked-${randomUUID()}`;
      const subject = `${MARK} marked`;

      const original = await openTicket(key, subject).expect(201);
      const replayed = await openTicket(key, subject).expect(201);

      expect(original.headers['idempotency-replayed']).toBeUndefined();
      expect(replayed.headers['idempotency-replayed']).toBe('true');
    });

    it('holds across a restart of the process', async () => {
      // The reason this table is Postgres and not Redis, asserted directly. An
      // in-memory or evictable store would answer 201-and-a-second-Ticket here.
      const key = `${MARK}-restart-${randomUUID()}`;
      const subject = `${MARK} restart`;

      const original = await openTicket(key, subject).expect(201);

      await app.close();
      app = await bootApp();

      const replayed = await openTicket(key, subject).expect(201);

      expect(replayed.body).toEqual(original.body);
      expect(replayed.headers['idempotency-replayed']).toBe('true');
      expect(await ticketsMarked(subject)).toHaveLength(1);
    });
  });

  describe('contention', () => {
    it('answers a duplicate arriving mid-flight with a distinct 409', async () => {
      // Staged rather than raced, because "the original has not finished" is a
      // window a real burst cannot be relied on to land in. The row below is
      // exactly what the interceptor writes before calling the handler —
      // including the fingerprint, which has to be the *matching* one: a
      // duplicate carrying a different body is a key-reuse bug and is answered
      // 422, and staging a mismatched hash would test that case by accident.
      const key = `${MARK}-inflight-${randomUUID()}`;
      const subject = `${MARK} inflight`;

      await asOwner(
        `INSERT INTO idempotency_record (id, tenant_id, scope, key, request_hash, status, actor_kind, actor_id)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, 'in_progress', 'user', $5)`,
        [
          meridian,
          `u:${agentId}|POST /tickets`,
          key,
          requestFingerprint({ subject, contactId, source: 'portal' }),
          agentId,
        ],
      );

      const response = await openTicket(key, subject).expect(409);

      // Distinct from `conflict`, and that distinction is the point: this one is
      // safe to retry, whereas a resource conflict means stop.
      expect(response.body.error.code).toBe('idempotency_in_flight');
      expect(await ticketsMarked(subject)).toHaveLength(0);
    });
  });

  describe('key reuse', () => {
    it('refuses the same key carrying a different payload with 422', async () => {
      const key = `${MARK}-reuse-${randomUUID()}`;

      await openTicket(key, `${MARK} original`).expect(201);

      const response = await openTicket(key, `${MARK} different`).expect(422);

      expect(response.body.error.code).toBe('idempotency_key_reused');
      // Refused rather than answered from the first request's cache — which
      // would have reported a Ticket created that never was.
      expect(await ticketsMarked(`${MARK} different`)).toHaveLength(0);
    });

    it('ignores the order the same payload’s keys were serialised in', async () => {
      const key = `${MARK}-order-${randomUUID()}`;
      const subject = `${MARK} ordering`;

      const send = (body: object) =>
        server()
          .post('/tickets')
          .set('Authorization', `Bearer ${agentToken}`)
          .set('Idempotency-Key', key)
          .send(body);

      await send({ subject, contactId, source: 'portal' }).expect(201);

      // A client retrying makes no promise about key order, and treating a
      // reshuffle as a different request would reject the very retry this
      // exists to allow.
      const replayed = await send({ source: 'portal', contactId, subject });

      expect(replayed.status).toBe(201);
      expect(replayed.headers['idempotency-replayed']).toBe('true');
    });
  });

  describe('opting out', () => {
    it('accepts a request with no key and simply makes no promise', async () => {
      const subject = `${MARK} unkeyed`;

      await openTicket(null, subject).expect(201);
      await openTicket(null, subject).expect(201);

      // Two Tickets, and that is correct. The header is opt-in; an absent one
      // means today's behaviour rather than a rejection.
      expect(await ticketsMarked(subject)).toHaveLength(2);
      expect(await recordsFor(subject)).toHaveLength(0);
    });

    it('leaves GET alone', async () => {
      await server()
        .get('/tickets')
        .set('Authorization', `Bearer ${agentToken}`)
        .set('Idempotency-Key', `${MARK}-get-${randomUUID()}`)
        .expect(200);
    });
  });

  describe('isolation', () => {
    it('gives two principals in one tenant their own records for one key', async () => {
      // The leak this design forecloses: without the principal in the scope,
      // the admin's request would be answered with the agent's cached Ticket.
      const key = `${MARK}-principals-${randomUUID()}`;

      await openTicket(key, `${MARK} agent's`, agentToken).expect(201);
      await openTicket(key, `${MARK} admin's`, adminToken).expect(201);

      expect(await ticketsMarked(`${MARK} agent's`)).toHaveLength(1);
      expect(await ticketsMarked(`${MARK} admin's`)).toHaveLength(1);
      expect(await recordsFor(key)).toHaveLength(2);
    });

    it('never lets one tenant’s record answer another tenant’s request', async () => {
      const key = `${MARK}-tenants-${randomUUID()}`;

      await openTicket(key, `${MARK} meridian`).expect(201);

      const rows = await asOwner<{ tenant_id: string }>(
        'SELECT tenant_id::text FROM idempotency_record WHERE key = $1',
        [key],
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].tenant_id).toBe(meridian);
      expect(rows[0].tenant_id).not.toBe(sortwood);
    });
  });

  describe('retention', () => {
    it('lets a lapsed key be claimed again without waiting for the sweep', async () => {
      // Expiry is enforced by `claim()` itself, so the 24-hour window holds to
      // the second whether or not the scheduler is keeping up. Backdating rather
      // than waiting is the only way this test can exist, and it is also the
      // honest way — the deadline is a column, so "what happens tomorrow" is a
      // question the schema can be asked.
      const key = `${MARK}-lapsed-${randomUUID()}`;

      await openTicket(key, `${MARK} before`).expect(201);
      await expire(key);

      const after = await openTicket(key, `${MARK} after`);

      expect(after.status).toBe(201);
      expect(after.headers['idempotency-replayed']).toBeUndefined();
      expect(await ticketsMarked(`${MARK} after`)).toHaveLength(1);

      // Reclaimed in place rather than duplicated: the key is still unique.
      const rows = await recordsFor(key);
      expect(rows).toHaveLength(1);
      expect(rows[0].expires_at.getTime()).toBeGreaterThan(Date.now());
    });

    it('stamps a deadline roughly 24 hours out', async () => {
      const key = `${MARK}-window-${randomUUID()}`;

      await openTicket(key, `${MARK} window`).expect(201);

      const [row] = await recordsFor(key);
      const hoursOut = (row.expires_at.getTime() - Date.now()) / 3_600_000;

      expect(hoursOut).toBeGreaterThan(23.9);
      expect(hoursOut).toBeLessThan(24.1);
    });

    it('is swept away once expired, and only once expired', async () => {
      const stale = `${MARK}-stale-${randomUUID()}`;
      const fresh = `${MARK}-fresh-${randomUUID()}`;

      await openTicket(stale, `${MARK} stale`).expect(201);
      await openTicket(fresh, `${MARK} fresh`).expect(201);
      await expire(stale);

      const sweep = app.get(IdempotencyRetentionSweep);

      await sweep.run(new Date());
      // Twice, like every other sweep in this codebase: idempotence here is a
      // property of a WHERE clause rather than of a flag, and a suite that ran
      // it once would pass against an implementation that could not be run
      // safely on a tick.
      await sweep.run(new Date());

      expect(await recordsFor(stale)).toHaveLength(0);
      expect(await recordsFor(fresh)).toHaveLength(1);
    });
  });

  describe('the non-HTTP consumer', () => {
    // What ticket 17 will build inbound Slack `event_id` dedupe on. It shares
    // the table and the scoping and uses none of the HTTP machinery — no header,
    // no route, and no response to cache — which is the whole reason `scope` is a
    // column rather than the route being the key.
    const context = () => ({
      tenantId: meridian,
      actor: { kind: 'system' as const },
    });

    const ref = (key: string) => ({ scope: 'slack:event', key });

    it('claims an unseen event once and recognises every redelivery', async () => {
      const idempotency = app.get(IdempotencyService);
      const event = ref(`${MARK}-Ev${randomUUID()}`);

      expect(await idempotency.claim(context(), event, 'hash')).toEqual({
        outcome: 'fresh',
      });

      await idempotency.complete(context(), event);

      // No response stored, because there is nobody to answer. A redelivery is
      // told the work is done and drops the event.
      expect(await idempotency.claim(context(), event, 'hash')).toEqual({
        outcome: 'replay',
        response: null,
      });
    });

    it('does not collide with an HTTP caller holding the same key', async () => {
      const idempotency = app.get(IdempotencyService);
      const shared = `${MARK}-shared-${randomUUID()}`;

      await openTicket(shared, `${MARK} shared`).expect(201);

      expect(await idempotency.claim(context(), ref(shared), 'hash')).toEqual({
        outcome: 'fresh',
      });

      expect(await recordsFor(shared)).toHaveLength(2);
    });

    it('absorbs a redelivery whose envelope is not byte-identical', async () => {
      // The dedupe contract is "same event_id, already handled" — there is no
      // payload comparison in it. Slack redelivers at-least-once and does not
      // promise an identical envelope, so a consumer forced to supply a hash
      // would see `mismatch` (a key-reuse *bug*) for an ordinary redelivery and
      // reprocess nothing while reporting a fault. Omitting the hash is how a
      // consumer says "do not compare payloads".
      const idempotency = app.get(IdempotencyService);
      const event = ref(`${MARK}-Ev${randomUUID()}`);

      expect(await idempotency.claim(context(), event)).toEqual({
        outcome: 'fresh',
      });
      await idempotency.complete(context(), event);

      expect(await idempotency.claim(context(), event)).toEqual({
        outcome: 'replay',
        response: null,
      });
    });

    it('releases a claim whose work failed, so the event can be retried', async () => {
      const idempotency = app.get(IdempotencyService);
      const event = ref(`${MARK}-Ev${randomUUID()}`);

      await idempotency.claim(context(), event, 'hash');
      await idempotency.release(context(), event);

      // The reason there is no `failed` status: a key held forever by a
      // transient fault is a key poisoned by exactly what retries are for.
      expect(await idempotency.claim(context(), event, 'hash')).toEqual({
        outcome: 'fresh',
      });
    });
  });

  /** Backdates a record's deadline, so "tomorrow" is a thing a test can reach. */
  const expire = (key: string) =>
    asOwner(
      `UPDATE idempotency_record SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 minute' WHERE key = $1`,
      [key],
    );

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
});
