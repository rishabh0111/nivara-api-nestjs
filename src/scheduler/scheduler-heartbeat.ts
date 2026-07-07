import { Injectable } from '@nestjs/common';
import { TickReport } from './readiness';

/**
 * The ticker's pulse, held in memory.
 *
 * In memory rather than in a column, and that is the correct scope rather than
 * a shortcut. Readiness answers "should *this* process be given traffic", and
 * the ticker is in *this* process — a heartbeat in the database would be
 * written by whichever instance is healthy and read by the wedged one, so a
 * stalled process would report itself fine on its neighbour's pulse. The one
 * failure the endpoint exists to catch is exactly the one that would hide.
 *
 * A tick registers before it first runs, with a null beat. That is what makes a
 * ticker which was started and never fired report as stalled rather than as
 * absent: "enabled but silent" and "not enabled" are different facts, and only
 * one of them is an outage.
 */
@Injectable()
export class SchedulerHeartbeat {
  private readonly ticks = new Map<
    string,
    { intervalMs: number; lastTickAt: Date | null }
  >();

  register(name: string, intervalMs: number): void {
    this.ticks.set(name, { intervalMs, lastTickAt: null });
  }

  /**
   * Recorded *after* a tick completes, never before it starts. A pulse written
   * on entry would keep beating for a tick that hangs forever, which is the
   * stall most worth reporting.
   */
  beat(name: string, at: Date): void {
    const tick = this.ticks.get(name);

    if (tick) tick.lastTickAt = at;
  }

  /** Whether any ticker was started in this process at all. */
  get started(): boolean {
    return this.ticks.size > 0;
  }

  report(): TickReport[] {
    return [...this.ticks].map(([name, { intervalMs, lastTickAt }]) => ({
      name,
      intervalMs,
      lastTickAt,
    }));
  }
}
