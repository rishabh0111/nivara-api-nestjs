import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import { DrainerService } from './drainer.service';
import { SchedulerHeartbeat } from './scheduler-heartbeat';
import { SweeperService } from './sweeper.service';

/**
 * The two tick rates.
 *
 * Config constants rather than part of the contract: the ports agree on *that*
 * there is a fast drain and a slow sweep, not on how fast. Both are chosen
 * against what the tick is for.
 */

/**
 * Fast, because a customer waiting on a reply is watching. Short enough that a
 * queued outbound delivery is indistinguishable from an immediate one, long
 * enough that an idle queue is a trivial indexed query every few seconds.
 */
export const FAST_TICK_MS = 3_000;

/**
 * Slow, because the things it scans are measured in hours and days. Sixty
 * seconds is far finer than any SLA target or the 7-day dwell window, so the
 * firing instant is immaterial — and the full scan is not worth running more
 * often than the answers can change.
 */
export const SLOW_TICK_MS = 60_000;

export const FAST_TICK = 'fast-drain';
export const SLOW_TICK = 'slow-sweep';

/**
 * The clock — the one piece of this feature that is not portable, and the only
 * one each port replaces.
 *
 * Plain intervals rather than a scheduling library. There is nothing to express
 * here that `setInterval` does not already say: no cron grammar, no persistence
 * (the jobs are the persistence), no distributed coordination (the claim's
 * `SKIP LOCKED` and the sweeps' predicates are the coordination). A dependency
 * would add a decorator syntax over the same two lines and a second place for
 * the tick rates to live.
 *
 * It runs in-process on the web service behind `RUN_SCHEDULER`, which is what
 * keeps splitting it into its own service a deploy change rather than a rewrite:
 * nothing here assumes co-location with anything, because safety rests on the
 * SQL rather than on being the only runner. Turning the flag off on the web
 * instances and on for one worker is the whole migration.
 *
 * Note what this class does *not* contain: any logic. It starts timers, records
 * heartbeats, and stops. Both ticks stay directly invokable precisely because
 * nothing worth testing lives in here.
 */
@Injectable()
export class SchedulerTicker
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(SchedulerTicker.name);
  private readonly timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly config: AppConfigService,
    private readonly heartbeat: SchedulerHeartbeat,
    private readonly drainer: DrainerService,
    private readonly sweeper: SweeperService,
  ) {}

  /**
   * `OnApplicationBootstrap` rather than `OnModuleInit`: the ticks reach into
   * services across the whole application, and a tick that fired while another
   * module was still initialising would be running against a half-built graph.
   * By this hook everything is constructed.
   */
  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.runScheduler) {
      this.logger.log(
        'Scheduler is off (RUN_SCHEDULER). The API is fully functional; queued and timed work will not run in this process.',
      );
      return;
    }

    await this.start(FAST_TICK, FAST_TICK_MS, () => this.drainer.tick());
    await this.start(SLOW_TICK, SLOW_TICK_MS, () => this.sweeper.tick());

    this.logger.log(
      `Scheduler is on — draining every ${FAST_TICK_MS}ms, sweeping every ${SLOW_TICK_MS}ms`,
    );
  }

  onApplicationShutdown(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.length = 0;
  }

  private async start(
    name: string,
    intervalMs: number,
    tick: () => Promise<unknown>,
  ): Promise<void> {
    // Registered before the first run, so a ticker that is started and never
    // fires reports as stalled rather than as absent.
    this.heartbeat.register(name, intervalMs);

    const timer = setInterval(() => {
      void this.runOnce(name, tick);
    }, intervalMs);

    // The interval must not be a reason the process stays alive. Without this,
    // a script that finished its work would hang on a timer that never ends.
    timer.unref();

    this.timers.push(timer);

    // And once immediately, rather than waiting out the first interval. Two
    // reasons, and the second is the load-bearing one: a restart should pick up
    // a backlog at once instead of leaving it for another tick, and readiness
    // has a pulse to report from the moment the process boots. Without this, a
    // freshly started instance would report a stalled ticker for its first few
    // intervals and fail its own health check during every deploy.
    //
    // Awaited, so bootstrap does not complete until the first tick has. It costs
    // one round trip at startup and buys two things: readiness never observes a
    // pulseless ticker in a process that is in fact fine, and — since `runOnce`
    // swallows everything — an immediate shutdown cannot catch a tick still
    // holding a transaction on a client that is being disconnected.
    await this.runOnce(name, tick);
  }

  /**
   * Runs one tick, swallowing whatever it throws.
   *
   * An unhandled rejection from a timer callback takes the process down in
   * modern Node, so a single transient database error would turn "one tick
   * failed" into "the service restarted". Both ticks are idempotent and the
   * next one is seconds away, so the right response to a failed tick is to note
   * it and wait for the next. The heartbeat is deliberately *not* recorded on
   * that path: a ticker firing on schedule and failing every time is not a
   * healthy ticker, so persistent failure surfaces as a stall on `/health/ready`
   * rather than as a log line nobody is reading.
   *
   * Overlap needs no guard either. A tick that runs long simply overlaps the
   * next, and both are safe under concurrency by the same mechanisms that make
   * two *processes* safe — the claim skips locked rows, the sweeps' predicates
   * fire once. A skip-if-running flag here would protect nothing and would
   * silently stop the ticker if the flag were ever left set.
   */
  private async runOnce(
    name: string,
    tick: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await tick();
      this.heartbeat.beat(name, new Date());
    } catch (error) {
      this.logger.error(
        `Scheduler tick ${name} failed`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
