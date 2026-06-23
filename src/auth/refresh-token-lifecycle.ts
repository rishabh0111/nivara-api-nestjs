/**
 * What a presented refresh token means, decided without a database.
 *
 * The rules that make rotation a security property rather than a ritual are
 * all here, as one pure function over one row's timestamps. Kept separate from
 * the service that reads and writes those rows because the interesting cases —
 * replay, eviction, the absolute cap — are precisely the ones that are painful
 * to stage against a live database and trivial to state as data.
 */

/** The window a single token is good for. Each rotation opens a fresh one. */
export const SLIDING_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The ceiling on a whole family, fixed at sign-in and copied unchanged onto
 * every successor. It is what makes the sliding window finite: without it, a
 * session refreshed inside every window never has to authenticate again.
 */
export const ABSOLUTE_LIFETIME_MS = 90 * 24 * 60 * 60 * 1000;

export const slidingExpiryFor = (now: Date): Date =>
  new Date(now.getTime() + SLIDING_WINDOW_MS);

export const familyExpiryFor = (now: Date): Date =>
  new Date(now.getTime() + ABSOLUTE_LIFETIME_MS);

/** The timestamps the verdict turns on — a structural subset of the row. */
export interface PresentedToken {
  expiresAt: Date;
  familyExpiresAt: Date;
  rotatedAt: Date | null;
  revokedAt: Date | null;
}

export type RefreshVerdict =
  /** Spend this token and issue its successor. */
  | { outcome: 'rotate' }
  /**
   * A spent token presented a second time. Two parties hold the same secret
   * and nothing distinguishes them, so the family is evicted rather than
   * guessed at — the legitimate client re-authenticates, and so does nobody
   * else.
   */
  | { outcome: 'replay' }
  /** Unusable, and unremarkable. The caller signs in again. */
  | { outcome: 'reject'; reason: 'revoked' | 'expired' | 'family_expired' };

/**
 * Order is load-bearing.
 *
 * `revoked` is checked before `rotated` because eviction rotates nothing but
 * leaves every row in the family both revoked and, for the spent ones, rotated.
 * Reading rotation first would report each retry after an eviction as a fresh
 * compromise, and a theft signal that fires on its own aftermath is one nobody
 * can act on.
 *
 * Expiry is checked after replay: an expired token that was already rotated is
 * still a token two parties held, and the family is worth evicting even though
 * this particular one would have been refused anyway.
 */
export const classifyPresentedToken = (
  token: PresentedToken,
  now: Date,
): RefreshVerdict => {
  if (token.revokedAt) return { outcome: 'reject', reason: 'revoked' };
  if (token.rotatedAt) return { outcome: 'replay' };
  if (token.familyExpiresAt <= now) {
    return { outcome: 'reject', reason: 'family_expired' };
  }
  if (token.expiresAt <= now) return { outcome: 'reject', reason: 'expired' };

  return { outcome: 'rotate' };
};
