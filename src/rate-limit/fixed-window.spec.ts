import { decide, windowBucket } from './fixed-window';

const perMinute = { limit: 3, windowSeconds: 60 };

/**
 * The arithmetic of a fixed window, with no store and no clock of its own.
 *
 * Everything that decides whether a request is refused lives here, so the two
 * call sites — the per-principal guard and the pre-trust Slack middleware —
 * share one implementation of "is this over the line" rather than each getting
 * the boundary conditions right separately.
 */
describe('the window bucket', () => {
  it('is stable for the whole of a window', () => {
    const start = windowBucket(60_000, 60);

    expect(windowBucket(60_000 + 59_999, 60)).toBe(start);
  });

  it('advances at the boundary', () => {
    expect(windowBucket(120_000, 60)).not.toBe(windowBucket(60_000, 60));
  });

  /**
   * Derived from absolute time rather than from a first-request timestamp, so
   * two processes serving the same principal agree about which window they are
   * counting into. A per-key start time would give each process its own
   * boundary and quietly double the effective ceiling.
   */
  it('agrees across callers that share a clock', () => {
    expect(windowBucket(99_123, 60)).toBe(windowBucket(99_999, 60));
  });
});

describe('the limit decision', () => {
  it('allows a count within the ceiling', () => {
    expect(decide(1, perMinute, 0).outcome).toBe('allowed');
    expect(decide(3, perMinute, 0).outcome).toBe('allowed');
  });

  it('refuses the request that crosses the ceiling', () => {
    expect(decide(4, perMinute, 0).outcome).toBe('denied');
  });

  /**
   * The whole of the fail-open promise, stated once. A null count is what the
   * counter answers when Redis is unreachable, and the only safe reading is
   * "let it through": a cache outage should cost the system its protection, not
   * its availability.
   */
  it('allows when the counter has no answer', () => {
    expect(decide(null, perMinute, 0).outcome).toBe('allowed');
  });

  /**
   * Measured to the window boundary, not from the refusal. At 90s into a
   * minute-windowed counter the window turns over at 120s, so a caller told to
   * wait 30 seconds finds a fresh budget when it returns rather than another
   * refusal.
   */
  it('reports a retry-after that lands in the next window', () => {
    const decision = decide(9, perMinute, 90_000);

    if (decision.outcome !== 'denied') throw new Error('expected a refusal');

    expect(decision.retryAfterSeconds).toBe(30);
  });

  /**
   * A caller refused in the last few milliseconds of a window would otherwise be
   * told to retry after zero seconds, which reads as "immediately" and invites
   * the tight loop the limit exists to stop.
   */
  it('never advises a retry-after below one second', () => {
    const decision = decide(9, perMinute, 119_999);

    if (decision.outcome !== 'denied') throw new Error('expected a refusal');

    expect(decision.retryAfterSeconds).toBe(1);
  });

  it('carries the ceiling it enforced, for the response headers', () => {
    const decision = decide(4, perMinute, 0);

    if (decision.outcome !== 'denied') throw new Error('expected a refusal');

    expect(decision.limit).toBe(3);
  });
});
