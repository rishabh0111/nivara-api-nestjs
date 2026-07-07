import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from 'src/app.module';
import { DrainerService } from 'src/scheduler/drainer.service';
import {
  JOB_HANDLERS,
  JobHandler,
  JobPayload,
} from 'src/scheduler/job-handler';
import { JobQueueService, LEASE_MS } from 'src/scheduler/job-queue.service';
import { Sweep, SWEEPS, SweeperService } from 'src/scheduler/sweeper.service';
import { TenancyService } from 'src/tenancy/tenancy.service';
import { asOwner } from './helpers/as-owner';
import { seededTenantIds, SeededTenants } from './helpers/seeded-tenants';

/**
 * The scheduler runtime, driven directly.
 *
 * Not one of these tests waits on a real interval. That is the property the
 * ticket asks for and it is worth stating why it matters beyond speed: the
 * effects this runtime will carry are keyed on days, so a test that waited for
 * its subject could not exist at all. Invoking `tick()` twice and asserting a
 * single effect — which several of these do — is only possible because the tick
 * is a method rather than a timer.
 */

/** Installed per test; the module-level registry reads through to it. */
let handlers: Record<string, JobHandler> = {};
let sweeps: Sweep[] = [];

interface JobRow {
  id: string;
  tenant_id: string;
  kind: string;
  status: string;
  attempts: number;
  max_attempts: number;
  run_after: Date;
  locked_at: Date | null;
  last_error: string | null;
}

const jobsOf = (tenantId: string): Promise<JobRow[]> =>
  asOwner<JobRow>(
    `SELECT id::text, tenant_id::text, kind, status::text, attempts, max_attempts,
            run_after, locked_at, last_error
       FROM job WHERE tenant_id = $1 ORDER BY created_at`,
    [tenantId],
  );

const jobById = async (id: string): Promise<JobRow> => {
  const rows = await asOwner<JobRow>(
    `SELECT id::text, tenant_id::text, kind, status::text, attempts, max_attempts,
            run_after, locked_at, last_error
       FROM job WHERE id = $1`,
    [id],
  );

  return rows[0];
};

describe('scheduler runtime', () => {
  let app: INestApplication;
  let tenants: SeededTenants;
  let queue: JobQueueService;
  let drainer: DrainerService;
  let sweeper: SweeperService;
  let tenancy: TenancyService;

  const enqueueFor = async (
    tenantId: string,
    kind: string,
    payload: JobPayload = {},
    options: { runAfter?: Date; maxAttempts?: number } = {},
  ): Promise<string> => {
    const before = await jobsOf(tenantId);

    await tenancy.withTenant({ tenantId, actor: { kind: 'system' } }, (tx) =>
      queue.enqueue(tx, { kind, payload, ...options }),
    );

    const after = await jobsOf(tenantId);
    const seen = new Set(before.map((job) => job.id));

    return after.find((job) => !seen.has(job.id))!.id;
  };

  beforeAll(async () => {
    tenants = await seededTenantIds();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      // Through a getter, so a test can install a handler after the container
      // has already resolved the registry into the drainer.
      .overrideProvider(JOB_HANDLERS)
      .useValue(
        new Proxy(
          {},
          { get: (_target, kind: string) => handlers[kind] },
        ) as Record<string, JobHandler>,
      )
      .overrideProvider(SWEEPS)
      .useValue(new Proxy([] as Sweep[], { get: reflectSweeps }))
      .compile();

    app = moduleRef.createNestApplication();
    await app.init();

    queue = app.get(JobQueueService);
    drainer = app.get(DrainerService);
    sweeper = app.get(SweeperService);
    tenancy = app.get(TenancyService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    handlers = {};
    sweeps = [];
    await asOwner('DELETE FROM job');
  });

  describe('enqueueing', () => {
    it('commits with the caller and not before', async () => {
      // The dual-write failure this closes: a job to deliver a message that was
      // never written, arriving as a handler that cannot find its own subject.
      await expect(
        tenancy.withTenant(
          { tenantId: tenants.meridian, actor: { kind: 'system' } },
          async (tx) => {
            await queue.enqueue(tx, { kind: 'test.noop', payload: {} });
            throw new Error('the caller changed its mind');
          },
        ),
      ).rejects.toThrow('changed its mind');

      expect(await jobsOf(tenants.meridian)).toEqual([]);
    });

    it('stamps the tenant from the armed context', async () => {
      // Never a parameter, so an enqueue site cannot name a tenant — and the
      // policy's WITH CHECK refuses one that tried.
      const id = await enqueueFor(tenants.sortwood, 'test.noop');

      expect((await jobById(id)).tenant_id).toBe(tenants.sortwood);
    });

    it('is claimable immediately by default', async () => {
      await enqueueFor(tenants.meridian, 'test.noop');

      expect(await drainer.tick()).toMatchObject({ claimed: 1 });
    });
  });

  describe('claiming', () => {
    it('leaves a job whose run_after is in the future alone', async () => {
      // Backoff is this column and nothing else, so "not yet due" has to be
      // observable purely as a row the claim declines.
      await enqueueFor(
        tenants.meridian,
        'test.noop',
        {},
        {
          runAfter: new Date(Date.now() + 60_000),
        },
      );

      expect(await drainer.tick()).toMatchObject({ claimed: 0 });
    });

    it('never hands the same job to two concurrent drainers', async () => {
      // The heart of `FOR UPDATE SKIP LOCKED`. Without it, two ticks overlapping
      // — which the ticker explicitly permits — would each run every handler,
      // and at-least-once would quietly become at-least-twice on every job.
      const ran: string[] = [];
      handlers['test.count'] = (payload) => {
        ran.push(payload.label as string);
        return Promise.resolve();
      };

      for (let i = 0; i < 12; i += 1) {
        await enqueueFor(tenants.meridian, 'test.count', { label: `job-${i}` });
      }

      // Each tick is capped at half the backlog, so neither drainer can take
      // the lot and leave the other with nothing. Without the cap the default
      // batch of 20 exceeds the 12 jobs available, one drainer legally claims
      // every one of them, and the assertions below pass with the two ticks
      // having never actually contended — which would make this test a
      // decoration rather than a proof.
      const now = new Date();
      const [first, second] = await Promise.all([
        drainer.tick(now, 6),
        drainer.tick(now, 6),
      ]);

      expect(first.claimed).toBe(6);
      expect(second.claimed).toBe(6);

      // The property itself: twelve jobs, twelve runs, no label seen twice.
      expect(ran).toHaveLength(12);
      expect(new Set(ran).size).toBe(12);
    });

    it('claims no more than the batch it was given', async () => {
      // Worth its own test because the failure mode is silent: an ignored bound
      // gives an unbounded claim, which behaves identically to a correct one
      // until a backlog arrives and a single tick tries to drain all of it. It
      // caught exactly that — `LIMIT` as a bound parameter does not survive this
      // driver, so the cap has to be inlined.
      handlers['test.noop'] = () => Promise.resolve();

      for (let i = 0; i < 8; i += 1) {
        await enqueueFor(tenants.meridian, 'test.noop');
      }

      expect(await drainer.tick(new Date(), 3)).toMatchObject({ claimed: 3 });
      expect(await drainer.tick(new Date(), 3)).toMatchObject({ claimed: 3 });
      expect(await drainer.tick(new Date(), 3)).toMatchObject({ claimed: 2 });
    });

    it('claims across tenants in one pass', async () => {
      // The queue is one queue. A drainer per tenant would need to know the
      // tenant list, which is the thing the claim is there to discover.
      const seen: string[] = [];
      handlers['test.tenant'] = (_payload, { tenantId }) => {
        seen.push(tenantId);
        return Promise.resolve();
      };

      await enqueueFor(tenants.meridian, 'test.tenant');
      await enqueueFor(tenants.sortwood, 'test.tenant');

      await drainer.tick();

      expect(seen.sort()).toEqual([tenants.meridian, tenants.sortwood].sort());
    });

    it('counts the attempt at claim, not at failure', async () => {
      // So a job that reliably kills the process still reaches `dead` rather
      // than being retried forever — the poison message that never dies.
      const id = await enqueueFor(tenants.meridian, 'test.unhandled');

      await drainer.tick();

      expect((await jobById(id)).attempts).toBe(1);
    });

    it('reclaims a job whose lease has expired', async () => {
      // A drainer killed between claiming and settling writes no failure and
      // releases no lock. Without the lease that row is `active` forever, and
      // the work is as lost as if the queue were not durable at all.
      const id = await enqueueFor(tenants.meridian, 'test.noop');
      handlers['test.noop'] = () => Promise.resolve();

      await asOwner(
        `UPDATE job SET status = 'active', locked_at = now() - interval '1 hour' WHERE id = $1`,
        [id],
      );

      expect(await drainer.tick()).toMatchObject({ claimed: 1 });
      expect((await jobById(id)).status).toBe('done');
    });

    it('leaves a job whose lease is still running to its holder', async () => {
      const id = await enqueueFor(tenants.meridian, 'test.noop');

      await asOwner(
        `UPDATE job SET status = 'active', locked_at = now() WHERE id = $1`,
        [id],
      );

      expect(await drainer.tick()).toMatchObject({ claimed: 0 });
      expect(LEASE_MS).toBeGreaterThan(60_000);
    });
  });

  describe('running', () => {
    it('runs the handler inside the tenant context of its own job', async () => {
      // The cross-tenant view the claim needed stops at this boundary: by the
      // time domain work happens the ordinary policies are armed, so a handler
      // sees exactly what a request in that tenant would.
      let visible: number | null = null;
      handlers['test.scope'] = async (_payload, { tx }) => {
        visible = await tx.ticket.count();
      };

      await enqueueFor(tenants.meridian, 'test.scope');
      await drainer.tick();

      const [{ count }] = await asOwner<{ count: string }>(
        'SELECT count(*)::text AS count FROM ticket WHERE tenant_id = $1',
        [tenants.meridian],
      );

      expect(visible).toBe(Number(count));
    });

    it('marks a successful job done and releases its lease', async () => {
      handlers['test.ok'] = () => Promise.resolve();
      const id = await enqueueFor(tenants.meridian, 'test.ok');

      expect(await drainer.tick()).toMatchObject({ claimed: 1, completed: 1 });

      expect(await jobById(id)).toMatchObject({
        status: 'done',
        locked_at: null,
      });
    });

    it('runs a completed job exactly once across repeated ticks', async () => {
      // Ticks overlap by design and a restart re-runs the loop, so "invoke it
      // twice, assert one effect" is the shape of the guarantee rather than a
      // paranoid extra.
      let runs = 0;
      handlers['test.once'] = () => {
        runs += 1;
        return Promise.resolve();
      };

      await enqueueFor(tenants.meridian, 'test.once');

      await drainer.tick();
      await drainer.tick();
      await drainer.tick();

      expect(runs).toBe(1);
    });

    it('sees a failure as a throw and schedules a retry in the future', async () => {
      handlers['test.flaky'] = () =>
        Promise.reject(new Error('the far end said no'));

      const id = await enqueueFor(tenants.meridian, 'test.flaky');
      const before = Date.now();

      expect(await drainer.tick()).toMatchObject({ retried: 1 });

      const job = await jobById(id);

      expect(job.status).toBe('ready');
      expect(job.locked_at).toBeNull();
      expect(job.last_error).toBe('the far end said no');
      expect(job.run_after.getTime()).toBeGreaterThan(before);
    });

    it('does not re-claim a retrying job on the very next tick', async () => {
      // Backoff has to be a wait, not a formality. Without a future run_after
      // a failing job would spin at the tick rate against whatever is down.
      let runs = 0;
      handlers['test.flaky'] = () => {
        runs += 1;
        return Promise.reject(new Error('still down'));
      };

      await enqueueFor(tenants.meridian, 'test.flaky');

      await drainer.tick();
      await drainer.tick();

      expect(runs).toBe(1);
    });

    it('dead-letters a job that exhausts its attempts', async () => {
      handlers['test.doomed'] = () =>
        Promise.reject(new Error('permanently broken'));

      const id = await enqueueFor(
        tenants.meridian,
        'test.doomed',
        {},
        { maxAttempts: 3 },
      );

      // Each tick is given a clock far enough ahead that the previous backoff
      // has elapsed — the same thing real time would do, without the waiting.
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        await drainer.tick(new Date(Date.now() + attempt * 3_600_000));
      }

      expect(await jobById(id)).toMatchObject({
        status: 'dead',
        attempts: 3,
        locked_at: null,
        last_error: 'permanently broken',
      });
    });

    it('leaves a dead job alone forever after', async () => {
      // Terminal means terminal: a dead job is something a human decides about,
      // and notify-don't-mutate says nothing retries it on its own.
      handlers['test.doomed'] = () =>
        Promise.reject(new Error('permanently broken'));

      const id = await enqueueFor(
        tenants.meridian,
        'test.doomed',
        {},
        { maxAttempts: 1 },
      );

      await drainer.tick();
      expect((await jobById(id)).status).toBe('dead');

      expect(
        await drainer.tick(new Date(Date.now() + 30 * 86_400_000)),
      ).toMatchObject({ claimed: 0 });
    });

    it('dead-letters an unrecognised kind rather than skipping it', async () => {
      // A row silently skipped forever is invisible in exactly the way a lost
      // job is. Failing it puts it where an operator already looks.
      const id = await enqueueFor(
        tenants.meridian,
        'test.no-such-handler',
        {},
        { maxAttempts: 1 },
      );

      await drainer.tick();

      const job = await jobById(id);

      expect(job.status).toBe('dead');
      expect(job.last_error).toContain('No handler is registered');
    });

    it('keeps draining the batch when one job throws', async () => {
      handlers['test.bad'] = () => Promise.reject(new Error('nope'));
      let good = 0;
      handlers['test.good'] = () => {
        good += 1;
        return Promise.resolve();
      };

      await enqueueFor(tenants.meridian, 'test.bad');
      await enqueueFor(tenants.meridian, 'test.good');
      await enqueueFor(tenants.meridian, 'test.good');

      expect(await drainer.tick()).toMatchObject({
        claimed: 3,
        completed: 2,
        retried: 1,
      });
      expect(good).toBe(2);
    });
  });

  describe('the slow sweep', () => {
    it('runs every registered sweep', async () => {
      const ran: string[] = [];
      sweeps = ['sla-breach', 'dwell'].map((name) => ({
        name,
        run: () => {
          ran.push(name);
          return Promise.resolve();
        },
      }));

      expect(await sweeper.tick()).toEqual({
        ran: ['sla-breach', 'dwell'],
        failed: [],
      });
      expect(ran).toEqual(['sla-breach', 'dwell']);
    });

    it('runs the remaining sweeps when one fails', async () => {
      // They are independent scans over independent predicates. A transient
      // fault in one is no reason for the others to stop for the day.
      let reached = false;
      sweeps = [
        {
          name: 'broken',
          run: () => Promise.reject(new Error('scan failed')),
        },
        {
          name: 'fine',
          run: () => {
            reached = true;
            return Promise.resolve();
          },
        },
      ];

      expect(await sweeper.tick()).toEqual({
        ran: ['fine'],
        failed: ['broken'],
      });
      expect(reached).toBe(true);
    });

    it('passes the tick its clock, so a sweep never reads one of its own', async () => {
      // Every sweep this runtime will carry is a time comparison. Taking the
      // instant as an argument is what makes a 7-day threshold testable.
      const now = new Date('2026-07-19T12:00:00.000Z');
      let seen: Date | undefined;

      sweeps = [
        {
          name: 'clock',
          run: (at) => {
            seen = at;
            return Promise.resolve();
          },
        },
      ];

      await sweeper.tick(now);

      expect(seen).toEqual(now);
    });

    it('is a no-op with nothing registered', async () => {
      expect(await sweeper.tick()).toEqual({ ran: [], failed: [] });
    });
  });

  describe('isolation', () => {
    it('shows a tenant only its own jobs', async () => {
      await enqueueFor(tenants.meridian, 'test.mine');
      await enqueueFor(tenants.sortwood, 'test.theirs');

      const visible = await tenancy.withTenant(
        { tenantId: tenants.meridian, actor: { kind: 'system' } },
        (tx) => tx.job.findMany(),
      );

      expect(visible.map((job) => job.kind)).toEqual(['test.mine']);
    });

    it('hides jobs from a Contact, as `note` and `service_token` do', async () => {
      await enqueueFor(tenants.meridian, 'test.mine');

      const visible = await tenancy.withTenant(
        {
          tenantId: tenants.meridian,
          // A Contact id is not needed to prove the clause: the actor *kind* is
          // what the policy reads.
          actor: { kind: 'contact', id: tenants.meridian },
        },
        (tx) => tx.job.findMany(),
      );

      expect(visible).toEqual([]);
    });

    it('lets the scheduler context see the jobs of every tenant', async () => {
      await enqueueFor(tenants.meridian, 'test.mine');
      await enqueueFor(tenants.sortwood, 'test.theirs');

      const visible = await tenancy.withScheduler((tx) => tx.job.findMany());

      expect(visible.map((job) => job.kind).sort()).toEqual([
        'test.mine',
        'test.theirs',
      ]);
    });

    it('shows the scheduler context nothing but the queue', async () => {
      // The claim needs a cross-tenant view of one table. This asserts that is
      // all it got — the scheduler context is not a skeleton key, and every
      // domain table stays as invisible under it as under no context at all.
      //
      // Deliberately checked against tables the seed actually fills. A zero from
      // an empty table would pass whether the policies work or not, which is the
      // way a test like this quietly stops testing anything.
      const populated = await asOwner<{ table: string; count: string }>(
        `SELECT 'contact' AS table, count(*)::text FROM contact
         UNION ALL SELECT 'user', count(*)::text FROM "user"
         UNION ALL SELECT 'audit_log', count(*)::text FROM audit_log`,
      );

      expect(populated.every((row) => Number(row.count) > 0)).toBe(true);

      const seen = await tenancy.withScheduler(async (tx) => ({
        contacts: await tx.contact.count(),
        users: await tx.user.count(),
        auditLog: await tx.auditLog.count(),
      }));

      expect(seen).toEqual({ contacts: 0, users: 0, auditLog: 0 });
    });

    it('names the scheduler setting in the policies of exactly one table', async () => {
      // The blast radius of the escape hatch, asserted rather than reviewed. A
      // later migration that reached for the same clause to make its own life
      // easier fails here, which is the only place that would notice.
      const policies = await asOwner<{ tablename: string; policyname: string }>(
        `SELECT tablename, policyname
           FROM pg_policies
          WHERE qual LIKE '%app.scheduler%'
             OR with_check LIKE '%app.scheduler%'`,
      );

      expect(policies).toEqual([
        { tablename: 'job', policyname: 'scheduler_drain' },
      ]);
    });
  });
});

/** Lets `sweeps` be reassigned per test behind the array the container holds. */
function reflectSweeps(_target: Sweep[], property: string | symbol): unknown {
  const value = (sweeps as unknown as Record<string | symbol, unknown>)[
    property
  ];

  return typeof value === 'function' ? value.bind(sweeps) : value;
}
