import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from 'src/app.module';
import { RedisService } from 'src/redis/redis.service';
import { asOwner } from './helpers/as-owner';
import { seededTenantIds } from './helpers/seeded-tenants';

/**
 * The ceilings, on the real request path.
 *
 * Exactly one thing is replaced: `RedisService`, which is the store. Everything
 * else here is production — the real guard in the real ordered chain, the real
 * middleware ahead of the real signature check, the real key builders, the real
 * error envelope. That is the same boundary `slack.int-spec.ts` draws around
 * `SlackClient`, and for the same reason: what is worth asserting about a
 * limiter is which requests it refuses and what it says when it does, and
 * neither of those is a question about Redis.
 *
 * The arithmetic of the window and the shape of the keys are asserted directly
 * in `src/rate-limit/fixed-window.spec.ts` and `rate-limit-keys.spec.ts`. What
 * is left for this file is whether any of it is actually in the request path —
 * and, for the Slack route, whether it is in the *right place* in that path.
 *
 * Requires `docker compose up -d postgres && npm run db:migrate && npm run
 * db:seed`; see `npm run test:int`.
 */

const PASSWORD = 'nivara-demo-password';

/** The configured defaults, which these tests drive traffic up against. */
const AUTHENTICATED_LIMIT = 300;
const SLACK_IP_LIMIT = 60;
const SLACK_GLOBAL_LIMIT = 600;

/**
 * The store, under the test's control.
 *
 * `counts` is both the fixture and the assertion surface: seeding a key drives
 * a principal up to its ceiling without sending three hundred requests, and
 * reading the keys back is how tenant isolation is checked *without* rebuilding
 * the expected key from the same builder the code under test uses — which would
 * assert only that a function equals itself.
 *
 * `unavailable` is a Redis outage. It rejects rather than returning nothing,
 * because that is what an unreachable server actually does, and the fail-open
 * path has to survive a rejection rather than a falsy value.
 */
class FakeRedisService {
  readonly counts = new Map<string, number>();
  unavailable = false;

  readonly client = {
    multi: () => {
      let key = '';

      const chain = {
        incr: (k: string) => {
          key = k;
          return chain;
        },
        expire: () => chain,
        exec: () => {
          if (this.unavailable) {
            return Promise.reject(new Error('ECONNREFUSED'));
          }

          const next = (this.counts.get(key) ?? 0) + 1;
          this.counts.set(key, next);

          return Promise.resolve([
            [null, next],
            [null, 1],
          ]);
        },
      };

      return chain;
    },
  };

  /** Drives a key a request just charged up to its ceiling. */
  saturate(key: string, limit: number): void {
    this.counts.set(key, limit);
  }
}

describe('rate limiting', () => {
  let app: INestApplication;
  let redis: FakeRedisService;
  let meridian: string;
  let sortwood: string;
  let meridianToken: string;
  let sortwoodToken: string;

  beforeAll(async () => {
    ({ meridian, sortwood } = await seededTenantIds());

    redis = new FakeRedisService();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RedisService)
      .useValue(redis)
      .compile();

    // `rawBody`, exactly as `main.ts` sets it. The Slack tests below reach a
    // signature check that reads it, and without it they would refuse for a
    // reason unrelated to their subject.
    app = moduleRef.createNestApplication({ rawBody: true });
    await app.listen(0);

    meridianToken = await tokenFor(meridian, 'admin@meridian.test');
    sortwoodToken = await tokenFor(sortwood, 'admin@sortwood.test');
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    redis.counts.clear();
    redis.unavailable = false;
  });

  const server = () => request(app.getHttpServer());

  const tokenFor = async (tenantId: string, email: string): Promise<string> => {
    const { body } = await server()
      .post('/auth/sign-in')
      .send({ tenantId, email, password: PASSWORD })
      .expect(200);

    return body.accessToken as string;
  };

  const get = (token: string) =>
    server().get('/tickets').set('Authorization', `Bearer ${token}`);

  /**
   * A key the store was actually charged, found by its namespace.
   *
   * Read back rather than rebuilt from the key builders, deliberately. A test
   * that constructed the expected key with `authenticatedKey()` would assert
   * only that a function equals itself; this one asserts that the request path
   * charged *something*, and the isolation tests below assert that two callers
   * charged different things.
   */
  const keyContaining = (marker: string): string => {
    const key = [...redis.counts.keys()].find((k) => k.includes(marker));

    expect(key).toBeDefined();

    return key as string;
  };

  /** The single key an authenticated request charges. */
  const chargedKey = (): string => {
    expect(redis.counts.size).toBe(1);

    return [...redis.counts.keys()][0];
  };

  describe('the authenticated ceiling', () => {
    it('charges one key per request', async () => {
      await get(meridianToken).expect(200);

      expect(redis.counts.get(chargedKey())).toBe(1);
    });

    it('refuses the request that crosses the ceiling', async () => {
      await get(meridianToken).expect(200);
      redis.saturate(chargedKey(), AUTHENTICATED_LIMIT);

      await get(meridianToken).expect(429);
    });

    /**
     * The acceptance criterion, and the reason the tenant is in the key at all.
     * Meridian is driven to its ceiling and refused; Sortwood's identical
     * request is untouched, because it is counting somewhere else entirely.
     */
    it('does not let one tenant consume another tenant budget', async () => {
      await get(meridianToken).expect(200);
      redis.saturate(chargedKey(), AUTHENTICATED_LIMIT);

      await get(meridianToken).expect(429);
      await get(sortwoodToken).expect(200);
    });

    it('counts two tenants on two distinct keys', async () => {
      await get(meridianToken).expect(200);
      await get(sortwoodToken).expect(200);

      expect(redis.counts.size).toBe(2);
    });

    it('answers a refusal in the standard error envelope', async () => {
      await get(meridianToken).expect(200);
      redis.saturate(chargedKey(), AUTHENTICATED_LIMIT);

      const { body } = await get(meridianToken).expect(429);

      expect(body).toEqual({
        error: {
          code: 'rate_limited',
          message: expect.stringContaining(String(AUTHENTICATED_LIMIT)),
        },
      });
    });

    it('carries Retry-After and the rate-limit headers', async () => {
      await get(meridianToken).expect(200);
      redis.saturate(chargedKey(), AUTHENTICATED_LIMIT);

      const { headers } = await get(meridianToken).expect(429);

      expect(Number(headers['retry-after'])).toBeGreaterThan(0);
      expect(Number(headers['retry-after'])).toBeLessThanOrEqual(60);
      expect(headers['ratelimit-limit']).toBe(String(AUTHENTICATED_LIMIT));
      expect(headers['ratelimit-remaining']).toBe('0');
      expect(headers['ratelimit-reset']).toBe(headers['retry-after']);
    });

    /**
     * A refusal is not an act within a tenant — nobody did anything, which is
     * the point — and the audit log is the control plane's record of acts. It
     * is also a surface an attacker would otherwise get to write to for free,
     * one row per refused request, at exactly the moment the system is already
     * under load.
     *
     * Structurally true rather than merely observed: neither the guard nor the
     * middleware holds an `AuditService`. Asserted anyway, because a later edit
     * could add one.
     */
    it('writes no audit row for a refusal', async () => {
      await get(meridianToken).expect(200);
      redis.saturate(chargedKey(), AUTHENTICATED_LIMIT);

      const before = await auditRowCount();

      await get(meridianToken).expect(429);

      expect(await auditRowCount()).toBe(before);
    });
  });

  describe('when Redis is unavailable', () => {
    /**
     * The whole of the fail-open promise, over HTTP. The counter cannot answer,
     * so the ceiling is unenforceable — and the correct response to an
     * unenforceable ceiling is to serve the request. Failing closed would turn
     * a cache outage into a total API outage, which is strictly worse than the
     * abuse the ceiling protects against.
     */
    it('serves authenticated traffic rather than refusing it', async () => {
      redis.unavailable = true;

      await get(meridianToken).expect(200);
      await get(meridianToken).expect(200);
    });

    it('serves the public Slack route rather than refusing it', async () => {
      redis.unavailable = true;

      // 401, because the signature is absent — which is the *route's* refusal,
      // not the limiter's. Reaching it at all is the assertion.
      await server().post('/integrations/slack/events').send({}).expect(401);
    });
  });

  describe('the pre-trust Slack ceiling', () => {
    const post = (forwardedFor: string) =>
      server()
        .post('/integrations/slack/events')
        .set('X-Forwarded-For', forwardedFor)
        .send({ team_id: 'T_ATTACKER_CHOSEN', event_id: 'Ev1' });

    /**
     * The ordering criterion, and the one thing this suite could not assert any
     * other way. An unsigned request to this route is refused with 401 by the
     * signature check inside the handler. Once the limiter is saturated the
     * same request answers 429 instead — so the limiter reached a verdict
     * *before* verification ran, which is exactly "the flood is stopped at the
     * edge". Were the limiter a guard, or inside the handler, this would still
     * be a 401.
     */
    it('refuses before the signature is verified', async () => {
      await post('203.0.113.7').expect(401);

      redis.saturate(keyContaining(':ip:'), SLACK_IP_LIMIT);

      await post('203.0.113.7').expect(429);
    });

    /**
     * The envelope on the *middleware* path, which is a genuinely different
     * question from the guard path above.
     *
     * `AppException` extends `Error` rather than `HttpException`, so a refusal
     * thrown from middleware only becomes a catalogued 429 because the global
     * filter reaches exceptions raised before the router. That is a Nest
     * behaviour rather than something this code arranges, and the route it
     * guards is also the one endpoint in the API that otherwise answers outside
     * the envelope entirely — so asserting the status alone would leave the
     * body free to be Express's default HTML error page.
     */
    it('answers a refusal in the standard envelope, with headers', async () => {
      await post('203.0.113.7').expect(401);

      redis.saturate(keyContaining(':ip:'), SLACK_IP_LIMIT);

      const { body, headers } = await post('203.0.113.7').expect(429);

      expect(body).toEqual({
        error: {
          code: 'rate_limited',
          message: expect.stringContaining(String(SLACK_IP_LIMIT)),
        },
      });
      expect(Number(headers['retry-after'])).toBeGreaterThan(0);
      expect(headers['ratelimit-limit']).toBe(String(SLACK_IP_LIMIT));
      expect(headers['ratelimit-remaining']).toBe('0');
    });

    /**
     * The keying criterion. Both requests carry the same body and so the same
     * `team_id`; only the transport address differs. The second is served,
     * which it could not be if the unverified body had contributed to the key.
     */
    it('keys on the address rather than on the unverified body', async () => {
      await post('203.0.113.7').expect(401);

      redis.saturate(keyContaining(':ip:'), SLACK_IP_LIMIT);

      await post('203.0.113.7').expect(429);
      await post('198.51.100.9').expect(401);
    });

    /**
     * The forgery criterion. A caller prepending entries to `X-Forwarded-For`
     * is trying to mint a fresh bucket per request; the last entry is the hop
     * the platform proxy observed, so all three of these are one caller.
     */
    it('cannot be escaped by prepending forwarded entries', async () => {
      await post('203.0.113.7').expect(401);

      redis.saturate(keyContaining(':ip:'), SLACK_IP_LIMIT);

      await post('1.2.3.4, 203.0.113.7').expect(429);
      await post('5.6.7.8, 9.9.9.9, 203.0.113.7').expect(429);
    });

    /**
     * The backstop catches what per-IP cannot: volume spread across addresses,
     * where no single bucket is near its own ceiling. Saturating the global key
     * refuses an address that has never been seen before.
     */
    it('applies a global backstop across addresses', async () => {
      await post('203.0.113.7').expect(401);

      redis.saturate(keyContaining(':global:'), SLACK_GLOBAL_LIMIT);

      await post('198.51.100.9').expect(429);
    });
  });
});

const auditRowCount = async (): Promise<string> => {
  const [{ count }] = await asOwner<{ count: string }>(
    'SELECT count(*)::text AS count FROM audit_log',
  );

  return count;
};
