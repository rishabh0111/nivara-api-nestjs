/**
 * A ceiling and the span it is measured over.
 *
 * Carried together rather than as two numbers, because a limit read without its
 * window is meaningless and the pair is what every call site passes around.
 */
export interface RateLimit {
  readonly limit: number;
  readonly windowSeconds: number;
}

export type RateLimitDecision =
  | { outcome: 'allowed' }
  | {
      outcome: 'denied';
      /** The ceiling that was crossed, reported back in the response headers. */
      limit: number;
      /**
       * Whole seconds until the window turns over. At least one — see `decide`.
       *
       * A duration rather than the absolute reset timestamp, which is the only
       * form anything downstream wants: `Retry-After` is defined in seconds and
       * the `RateLimit-*` draft carries delta-seconds too. Carrying the epoch
       * second as well would be a second representation of one fact, kept in
       * step by hand and read by nobody.
       */
      retryAfterSeconds: number;
    };

/**
 * Which window a moment falls in, as the epoch second the window began.
 *
 * Fixed windows rather than a sliding log or a token bucket, and the reason is
 * that the counter has to be a single atomic operation against a store that may
 * vanish. A sliding window needs the timestamps of individual hits, which is a
 * sorted set to trim on every request; a token bucket needs a read, an
 * arithmetic step and a write, which is either a Lua script or a race. Both buy
 * a smoother edge at a burst boundary, and neither is worth the machinery for a
 * ceiling whose purpose is to stop one caller monopolising the API rather than
 * to shape traffic precisely.
 *
 * Derived from absolute time, so every process counting the same principal
 * agrees on the boundary without coordinating. A window anchored on a key's
 * first request would give each replica its own, which is the same ceiling
 * enforced twice over — quietly doubling it.
 */
export const windowBucket = (nowMs: number, windowSeconds: number): number =>
  Math.floor(nowMs / 1000 / windowSeconds) * windowSeconds;

/**
 * Whether a hit is over the line, given the count that hit produced.
 *
 * `count` is the value *after* the increment, so the first request of a window
 * arrives as 1 and a ceiling of 300 is crossed at 301. Comparing post-increment
 * is what makes the check a single round trip: there is no read-then-write, so
 * two concurrent requests cannot both observe 300 and both proceed.
 *
 * A `null` count means the store had no answer — it is unreachable, or it
 * failed — and that is allowed rather than refused. This is the whole of the
 * fail-open decision and it lives here, in the one place both call sites go
 * through, rather than as a try/catch each of them remembers to write. Losing
 * Redis should cost this system its rate limiting, which is a degradation, and
 * not its ability to serve requests, which is an outage.
 */
export const decide = (
  count: number | null,
  { limit, windowSeconds }: RateLimit,
  nowMs: number,
): RateLimitDecision => {
  if (count === null || count <= limit) return { outcome: 'allowed' };

  const resetAtEpochSeconds =
    windowBucket(nowMs, windowSeconds) + windowSeconds;

  return {
    outcome: 'denied',
    limit,
    // Floored at one second. The honest remainder in the last milliseconds of a
    // window rounds to zero, and a `Retry-After: 0` reads as "go ahead now",
    // which invites exactly the tight retry loop the ceiling exists to stop.
    retryAfterSeconds: Math.max(
      1,
      Math.ceil(resetAtEpochSeconds - nowMs / 1000),
    ),
  };
};
