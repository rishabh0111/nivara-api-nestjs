import { Injectable } from '@nestjs/common';

/**
 * How long without a real request before the ticks back off.
 *
 * Long enough that a person reading a ticket between replies is still "using"
 * the desk; short enough that an evening of nobody visiting is mostly idle.
 */
export const IDLE_AFTER_MS = 10 * 60_000;

/**
 * Both ticks' interval while idle.
 *
 * The free database suspends its compute after five minutes without a query,
 * and the monthly compute allowance is far below what an always-awake
 * database burns. At the active rates (3 s and 60 s) the database never
 * reaches that five minutes, so it ran around the clock. At thirty minutes it
 * sleeps for most of each interval, and nothing the ticks look after is
 * harmed: SLA targets and the dwell window are measured in hours and days,
 * and anything a person queues wakes the ticks at once (see `touch`).
 */
export const IDLE_TICK_MS = 30 * 60_000;

/**
 * Whether anyone is using the API, as the scheduler needs to know it.
 *
 * Fed by `SchedulerActivityMiddleware` on every request except the health
 * checks: an uptime monitor pinging `/health` keeps the *process* awake and
 * must not keep the *database* awake with it. Boot counts as activity, so a
 * fresh process ticks at full rate for its first window exactly as it always
 * has.
 */
@Injectable()
export class SchedulerActivity {
  private lastRequestAt = Date.now();
  private onWake: (() => void) | null = null;

  /** Records a real request; leaving idle wakes the ticks at once. */
  touch(now: number = Date.now()): void {
    const wasIdle = this.isIdle(now);
    this.lastRequestAt = now;

    if (wasIdle) this.onWake?.();
  }

  isIdle(now: number = Date.now()): boolean {
    return now - this.lastRequestAt > IDLE_AFTER_MS;
  }

  /** The ticker's hook. One listener: there is one clock. */
  whenWoken(listener: () => void): void {
    this.onWake = listener;
  }
}
