import { Inject, Injectable, Logger } from '@nestjs/common';
import { TenancyService } from '../tenancy/tenancy.service';
import { ClaimedJob, CLAIM_BATCH, JobQueueService } from './job-queue.service';
import { JOB_HANDLERS, JobHandler, JobHandlerRegistry } from './job-handler';

/** What one tick did, for tests and for the log line. */
export interface DrainSummary {
  claimed: number;
  completed: number;
  retried: number;
  dead: number;
}

/**
 * The fast tick: claim due jobs, run them, settle the outcome.
 *
 * Every call is a complete unit of work with no state carried between them,
 * which is what makes `tick()` safe to invoke directly. Tests drive it instead
 * of waiting on a real interval — and invoking it twice while asserting a single
 * effect is the test worth having, because at-least-once delivery makes double
 * invocation a thing that genuinely happens rather than a hypothetical.
 *
 * A job's handler runs inside `withTenant()` under the job's own tenant, so the
 * cross-tenant view the claim required stops at this boundary: by the time
 * anything domain-shaped happens, the ordinary policies are armed.
 */
@Injectable()
export class DrainerService {
  private readonly logger = new Logger(DrainerService.name);

  constructor(
    private readonly queue: JobQueueService,
    private readonly tenancy: TenancyService,
    @Inject(JOB_HANDLERS) private readonly handlers: JobHandlerRegistry,
  ) {}

  async tick(
    now: Date = new Date(),
    limit = CLAIM_BATCH,
  ): Promise<DrainSummary> {
    const jobs = await this.queue.claim(now, limit);
    const summary: DrainSummary = {
      claimed: jobs.length,
      completed: 0,
      retried: 0,
      dead: 0,
    };

    // Sequentially, not in parallel. Each job opens its own transaction, and a
    // batch fanned out concurrently would take a connection per job — a burst
    // in the queue would then starve the HTTP surface sharing the pool. The
    // tick is a background loop; it can afford to be the patient one.
    for (const job of jobs) {
      const outcome = await this.run(job, now);
      summary[outcome] += 1;
    }

    return summary;
  }

  private async run(
    job: ClaimedJob,
    now: Date,
  ): Promise<'completed' | 'retried' | 'dead'> {
    const handler: JobHandler | undefined = this.handlers[job.kind];

    // An unknown kind fails like any other failure rather than throwing out of
    // the tick, so one bad row cannot stop the queue. It will exhaust its
    // attempts and land in `dead`, which is where an operator looks — a row
    // silently skipped forever would be invisible in exactly the same way a
    // lost job is.
    if (!handler) {
      return this.settleFailure(
        job,
        new Error(`No handler is registered for job kind "${job.kind}"`),
        now,
      );
    }

    try {
      await this.tenancy.withTenant(
        { tenantId: job.tenantId, actor: { kind: 'system' } },
        (tx) =>
          handler(job.payload, {
            tx,
            tenantId: job.tenantId,
            attempt: job.attempts,
            maxAttempts: job.maxAttempts,
          }),
      );
    } catch (error) {
      return this.settleFailure(job, error, now);
    }

    await this.queue.complete(job.id, now);

    return 'completed';
  }

  private async settleFailure(
    job: ClaimedJob,
    error: unknown,
    now: Date,
  ): Promise<'retried' | 'dead'> {
    const { outcome } = await this.queue.fail(job, error, now);

    // Logged at the level the outcome deserves: a retry is expected operation
    // and a dead job is something a human has to decide about.
    if (outcome === 'dead') {
      this.logger.error(
        `Job ${job.id} (${job.kind}) is dead after ${job.attempts} attempts`,
        error instanceof Error ? error.stack : undefined,
      );
      return 'dead';
    }

    this.logger.warn(
      `Job ${job.id} (${job.kind}) failed on attempt ${job.attempts}, retrying later`,
    );

    return 'retried';
  }
}
