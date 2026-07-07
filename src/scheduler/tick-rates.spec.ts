import { STALE_TICK_MULTIPLIER } from './readiness';
import {
  FAST_TICK,
  FAST_TICK_MS,
  SLOW_TICK,
  SLOW_TICK_MS,
} from './scheduler-ticker.service';

/**
 * The two tick rates, asserted rather than merely declared.
 *
 * Small tests, but the constants they guard are the kind that get "tuned" in a
 * hurry — and each of the relationships below is load-bearing somewhere that
 * would fail silently rather than loudly if it stopped holding.
 */
describe('tick rates', () => {
  it('gives the two ticks genuinely separate intervals', () => {
    // The whole reason there are two: latency and cost should each match their
    // workload. Collapsing them to one rate means either scanning for 7-day
    // thresholds every three seconds, or making a customer wait a minute for a
    // reply that is already written.
    expect(FAST_TICK_MS).toBeLessThan(SLOW_TICK_MS);
  });

  it('keeps the fast tick fast enough to feel immediate', () => {
    expect(FAST_TICK_MS).toBeLessThanOrEqual(5_000);
  });

  it('names the ticks distinctly, since the heartbeat is keyed on the name', () => {
    // Two ticks sharing a name would overwrite each other's pulse in the
    // heartbeat map, and a stalled sweeper would be masked by a healthy
    // drainer — a readiness check that reports 200 through the outage.
    expect(FAST_TICK).not.toEqual(SLOW_TICK);
  });

  it('leaves the slow sweep room to miss a tick without reading as stalled', () => {
    // Readiness allows STALE_TICK_MULTIPLIER intervals of silence. If the slow
    // tick were ever set longer than a deploy's health-check grace period this
    // would need revisiting; the assertion exists so that change is deliberate.
    expect(SLOW_TICK_MS * STALE_TICK_MULTIPLIER).toBeLessThanOrEqual(300_000);
  });
});
