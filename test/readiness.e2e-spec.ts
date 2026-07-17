import { INestApplication } from '@nestjs/common';
import { JobQueueService } from 'src/scheduler/job-queue.service';
import {
  FAST_TICK,
  FAST_TICK_MS,
  SLOW_TICK,
} from 'src/scheduler/scheduler-ticker.service';
import { TenancyService } from 'src/tenancy/tenancy.service';
import request from 'supertest';
import { asOwner } from './helpers/as-owner';
import {
  UNREACHABLE_DATABASE_URL,
  UNREACHABLE_REDIS_URL,
} from './helpers/unreachable-urls';
import { bootApp, bootAppUnderCurrentEnv } from './helpers/boot';
import { withEnv } from './helpers/env';
import { seededTenantIds } from './helpers/seeded-tenants';

/**
 * Readiness, and the line between it and liveness.
 *
 * The two endpoints answer different questions — "can this process work" versus
 * "is this process alive" — and the whole value of the split is that one can
 * fail while the other does not. Several tests below assert exactly that
 * divergence rather than either endpoint alone.
 */
describe('GET /health/ready', () => {
  describe('with the scheduler off, as the default', () => {
    let app: INestApplication;

    beforeAll(async () => {
      app = await bootApp();
    });

    afterAll(async () => {
      await app.close();
    });

    it('is ready, reporting the scheduler dormant rather than broken', async () => {
      // `RUN_SCHEDULER` off is a supported deploy shape, not a degraded one —
      // it is what every web instance looks like once the ticker moves to its
      // own service. A 503 here would make the flag unusable for its purpose.
      const response = await request(app.getHttpServer()).get('/health/ready');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        status: 'ok',
        database: { status: 'ok' },
        // Dormant rather than degraded: the suite runs with no `REDIS_URL` at
        // all, which is the same configuration the credential-free first run
        // boots in, and it is a supported one rather than a fault.
        redis: { status: 'dormant' },
        scheduler: { status: 'disabled', ticks: [] },
      });
    });

    it('serves the rest of the API with no scheduler in the process', async () => {
      // The ticket's claim that the API is fully functional with the flag off,
      // asserted against a route that has nothing to do with health.
      const response = await request(app.getHttpServer()).get(
        '/meta/error-codes',
      );

      expect(response.status).toBe(200);
    });

    it('leaves a due job unclaimed, because no ticker is running', async () => {
      // The other half of the flag, and the half an empty `ticks` array only
      // implies. "The scheduler runs only when RUN_SCHEDULER is enabled" is a
      // claim about work not happening, so it has to be asserted against a job
      // that would certainly have been claimed had a drainer been present.
      const tenants = await seededTenantIds();
      const tenancy = app.get(TenancyService);

      await tenancy.withTenant(
        { tenantId: tenants.meridian, actor: { kind: 'system' } },
        (tx) =>
          app
            .get(JobQueueService)
            .enqueue(tx, { kind: 'test.never-drained', payload: {} }),
      );

      try {
        // Comfortably longer than the fast tick, so a ticker that was running
        // would have had several chances at it.
        await new Promise((resolve) => setTimeout(resolve, FAST_TICK_MS * 2));

        const [job] = await asOwner<{ status: string; attempts: number }>(
          `SELECT status::text, attempts FROM job WHERE kind = 'test.never-drained'`,
        );

        expect(job).toMatchObject({ status: 'ready', attempts: 0 });
      } finally {
        await asOwner(`DELETE FROM job WHERE kind = 'test.never-drained'`);
      }
      // The one test here that genuinely has to wait: proving something did
      // *not* happen means giving it the time in which it would have.
    }, 15_000);
  });

  describe('with the scheduler on', () => {
    it('reports both ticks beating', async () => {
      await withEnv({ RUN_SCHEDULER: 'true' }, async () => {
        const app = await bootAppUnderCurrentEnv();

        try {
          const response = await request(app.getHttpServer()).get(
            '/health/ready',
          );

          expect(response.status).toBe(200);
          expect(response.body.scheduler.status).toBe('ok');
          expect(
            response.body.scheduler.ticks.map((t: { name: string }) => t.name),
          ).toEqual([FAST_TICK, SLOW_TICK]);
        } finally {
          await app.close();
        }
      });
    });

    it('has a pulse immediately, without waiting out an interval', async () => {
      // Both ticks run once at bootstrap. Without that, a freshly started
      // instance would report a stalled ticker and fail its own health check
      // during every deploy — while it was in fact working perfectly.
      await withEnv({ RUN_SCHEDULER: 'true' }, async () => {
        const app = await bootAppUnderCurrentEnv();

        try {
          const { body } = await request(app.getHttpServer()).get(
            '/health/ready',
          );

          for (const tick of body.scheduler.ticks) {
            expect(tick.lastTickAt).not.toBeNull();
            expect(tick.status).toBe('ok');
          }
        } finally {
          await app.close();
        }
      });
    });

    it('answers 503 when a tick has stalled, naming which one', async () => {
      // The failure the endpoint exists for, and the one no other check can
      // see: the HTTP surface stays perfect while every timed promise the
      // product makes quietly stops. Registering a tick that never beats is
      // exactly the state a wedged ticker leaves behind.
      await withEnv({ RUN_SCHEDULER: 'true' }, async () => {
        const app = await bootAppUnderCurrentEnv();

        try {
          // Resolved from the *fresh* module registry. `bootAppUnderCurrentEnv`
          // calls `jest.resetModules()`, so the class imported at the top of
          // this file is a different object from the one the running container
          // keyed its provider on — and `app.get()` on the stale one finds
          // nothing.
          /* eslint-disable @typescript-eslint/no-require-imports */
          const { SchedulerHeartbeat: Fresh } =
            require('src/scheduler/scheduler-heartbeat') as typeof import('src/scheduler/scheduler-heartbeat');
          /* eslint-enable @typescript-eslint/no-require-imports */

          app.get(Fresh).register('wedged-tick', 1);

          const response = await request(app.getHttpServer()).get(
            '/health/ready',
          );

          expect(response.status).toBe(503);
          expect(response.body.status).toBe('unavailable');
          expect(response.body.scheduler.status).toBe('stalled');
          expect(response.body.scheduler.ticks).toContainEqual(
            expect.objectContaining({ name: 'wedged-tick', status: 'stalled' }),
          );

          // And liveness is untouched by it. A wedged ticker is a reason to
          // route around this process, never a reason to restart it — if the
          // keep-warm ping failed here, the free-tier service would be allowed
          // to sleep, which stops the ticker for good.
          await request(app.getHttpServer()).get('/health').expect(200);
        } finally {
          await app.close();
        }
      });
    });
  });

  describe('with Redis configured and unreachable', () => {
    it('reports it degraded and stays ready, because it fails open', async () => {
      // The asymmetry between Redis and the other two dependencies, asserted
      // end to end. Redis backs rate limiting and the cache, both of which fail
      // open, so a process that cannot reach it answers every request correctly
      // and simply enforces no ceilings. A 503 here would take a working
      // deployment out of rotation — and take every instance out together,
      // since they all share one Redis.
      await withEnv({ REDIS_URL: UNREACHABLE_REDIS_URL }, async () => {
        const app = await bootAppUnderCurrentEnv();

        try {
          const response = await request(app.getHttpServer()).get(
            '/health/ready',
          );

          expect(response.status).toBe(200);
          expect(response.body.status).toBe('ok');
          expect(response.body.redis.status).toBe('degraded');
        } finally {
          await app.close();
        }
      });
    });
  });

  describe('with the database unreachable', () => {
    it('answers 503 while liveness still answers 200', async () => {
      await withEnv({ DATABASE_URL: UNREACHABLE_DATABASE_URL }, async () => {
        const app = await bootAppUnderCurrentEnv();

        try {
          const response = await request(app.getHttpServer()).get(
            '/health/ready',
          );

          expect(response.status).toBe(503);
          expect(response.body.database.status).toBe('unavailable');

          await request(app.getHttpServer()).get('/health').expect(200);
        } finally {
          await app.close();
        }
      });
    });
  });

  it('needs no credential', async () => {
    // A readiness probe has no token to present, and one that could fail on
    // authentication would report the process unfit for a reason unrelated to
    // whether it can serve.
    const app = await bootApp();

    try {
      await request(app.getHttpServer())
        .get('/health/ready')
        .set('Authorization', 'Bearer definitely-not-a-token')
        .expect(200);
    } finally {
      await app.close();
    }
  });
});
