import { Inject, Injectable, Logger, Optional } from '@nestjs/common';

/**
 * One time-based scan, run on the slow tick.
 *
 * A sweep acts *directly*, in its own transaction, rather than enqueueing work.
 * That is the line the queue is drawn on: the queue exists for effects that can
 * fail against something outside this process and therefore need retry
 * machinery, and a sweep's effects — latch a breach, transition a dwelling
 * ticket — touch nothing but Postgres. There is nothing to retry, so paying for
 * a queue round-trip would buy a guarantee that is already free.
 *
 * Sweeps exist at all because their effects fire on the *absence* of an event.
 * Every other change in the system rides a write that someone made; "nobody
 * replied for seven days" has no write to ride, so something has to go and look.
 *
 * Fire-once is the sweep's own responsibility and belongs in its SQL — a
 * set-once `IS NULL` latch, or a from-to transition guard — never in a lock
 * around the tick. Predicates are portable and survive two schedulers running
 * at once; a lock is a coordinator whose availability correctness would then
 * depend on.
 */
export interface Sweep {
  name: string;
  run(now: Date): Promise<void>;
}

/**
 * The injection token for the registered sweeps.
 *
 * Three sweeps: the SLA breach latch; the two 7-day dwell transitions, which
 * share one scan because they are the same question asked of two states; and
 * idempotency retention. Each arrived as a registration against this token and
 * changed nothing in the tick above — which is what the runtime landing first,
 * before there was anything for it to do, was for.
 */
export const SWEEPS = 'SWEEPS';

export interface SweepSummary {
  ran: string[];
  failed: string[];
}

/**
 * The slow tick: run every registered sweep, once.
 *
 * Directly invokable for the same reason the drainer is, and here it matters
 * more — the thresholds these sweeps watch are measured in days, so a test that
 * waited for a real one would never finish.
 */
@Injectable()
export class SweeperService {
  private readonly logger = new Logger(SweeperService.name);

  constructor(
    @Optional() @Inject(SWEEPS) private readonly sweeps: Sweep[] = [],
  ) {}

  async tick(now: Date = new Date()): Promise<SweepSummary> {
    const summary: SweepSummary = { ran: [], failed: [] };

    for (const sweep of this.sweeps) {
      try {
        await sweep.run(now);
        summary.ran.push(sweep.name);
      } catch (error) {
        // One sweep's failure must not cancel the others. They are independent
        // scans over independent predicates, and a transient fault in the SLA
        // scan is no reason for the dwell timers to stop for the day — the next
        // tick will retry it in sixty seconds anyway, since a sweep is
        // idempotent by construction.
        summary.failed.push(sweep.name);
        this.logger.error(
          `Sweep ${sweep.name} failed`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    return summary;
  }
}
