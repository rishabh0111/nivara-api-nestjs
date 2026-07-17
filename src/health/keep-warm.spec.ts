import { SLOW_TICK_MS } from '../scheduler/scheduler-ticker.service';
import { KEEP_WARM_INTERVAL_MS, PLATFORM_IDLE_WINDOW_MS } from './keep-warm';

/**
 * The keep-warm cadence, asserted rather than left in a comment.
 *
 * These numbers live in three places that must agree — the deployment
 * blueprint, the README, and whatever external pinger is configured — and the
 * relationship between them is the only reason any of them is what it is. A
 * comment saying "5 minutes is comfortably inside the idle window" stops being
 * true silently; this stops being true loudly.
 */
describe('keep-warm cadence', () => {
  it('pings well inside the window in which the platform would sleep', () => {
    // The whole mechanism: inbound traffic arriving faster than the idle timer
    // means the timer never expires, the process never sleeps, and the
    // in-process ticker keeps running. Ping slower than the window and the
    // service naps between pings.
    expect(KEEP_WARM_INTERVAL_MS).toBeLessThan(PLATFORM_IDLE_WINDOW_MS);
  });

  it('leaves room for a missed ping rather than sitting on the boundary', () => {
    // A single failed or late ping must not be enough to let the service
    // sleep. At half the window or less, two consecutive pings have to fail
    // before the idle timer can expire.
    expect(KEEP_WARM_INTERVAL_MS * 2).toBeLessThanOrEqual(
      PLATFORM_IDLE_WINDOW_MS,
    );
  });

  it('pings far less often than the sweep it protects runs', () => {
    // The ping keeps the *process* awake; the process runs the sweeps. If the
    // ping interval were near the sweep interval, "keep the service warm" would
    // have quietly turned into "drive the schedule", and the sweeps' timing
    // would depend on an external service nobody in this repo controls.
    expect(KEEP_WARM_INTERVAL_MS).toBeGreaterThan(SLOW_TICK_MS);
  });
});
