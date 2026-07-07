/**
 * How long to wait before retrying a failed job.
 *
 * Pure, and deliberately so — the schedule is the part of retry worth reasoning
 * about, and it should be readable without a database or a clock. What consumes
 * it is one column: the delay becomes a future `run_after`, so "waiting" costs
 * nothing held open and survives a restart of the process that scheduled it.
 */

/** The first retry's distance. Short enough that a blip self-heals quickly. */
export const BASE_BACKOFF_MS = 5_000;

/**
 * The ceiling. An integration that has been down for an hour is not helped by
 * being retried in four more; a bounded schedule means a job resumes promptly
 * once the far end returns, and the queue's load stays flat while it does not.
 */
export const MAX_BACKOFF_MS = 15 * 60_000;

/** How far either side of the nominal delay a retry may land. */
export const JITTER_RATIO = 0.2;

/**
 * The exponent past which doubling has no effect, because the result is already
 * clamped. Computed rather than guessed, and applied *before* the shift so a
 * pathological attempt count produces a number rather than `Infinity`.
 */
const SATURATION_ATTEMPT =
  Math.ceil(Math.log2(MAX_BACKOFF_MS / BASE_BACKOFF_MS)) + 1;

/** A source of randomness, injectable so the schedule is testable. */
export type Random = () => number;

/**
 * The delay after `attempts` failed attempts, jittered.
 *
 * `attempts` is the count *including* the failure being scheduled away from, so
 * one means "the first attempt just failed" and yields `BASE_BACKOFF_MS`.
 *
 * The jitter is not decoration. A batch of jobs failing against one outage would
 * otherwise all become due at the same instant and arrive at the recovering
 * service as a thundering herd — the retry storm being the thing that keeps it
 * down. Spreading them over a window costs nothing and removes the correlation.
 */
export const backoffMs = (
  attempts: number,
  random: Random = Math.random,
): number => {
  const exponent = Math.min(Math.max(attempts, 1) - 1, SATURATION_ATTEMPT);
  const nominal = Math.min(BASE_BACKOFF_MS * 2 ** exponent, MAX_BACKOFF_MS);

  // Centred on the nominal delay: `random()` of 0.5 is no jitter at all.
  return nominal * (1 + JITTER_RATIO * (2 * random() - 1));
};

/**
 * When a job that just failed becomes claimable again.
 *
 * Takes `now` rather than reading the clock, because a scheduling decision that
 * cannot be reproduced from its inputs is one that has to be tested by waiting.
 */
export const nextRunAfter = (
  attempts: number,
  now: Date,
  random: Random = Math.random,
): Date => new Date(now.getTime() + backoffMs(attempts, random));
