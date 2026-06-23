import {
  ABSOLUTE_LIFETIME_MS,
  SLIDING_WINDOW_MS,
  classifyPresentedToken,
  familyExpiryFor,
  slidingExpiryFor,
} from './refresh-token-lifecycle';

const NOW = new Date('2026-07-18T12:00:00.000Z');

const ago = (ms: number) => new Date(NOW.getTime() - ms);
const ahead = (ms: number) => new Date(NOW.getTime() + ms);

/** A live, never-used token: the state every other case departs from. */
const live = {
  expiresAt: ahead(SLIDING_WINDOW_MS),
  familyExpiresAt: ahead(ABSOLUTE_LIFETIME_MS),
  rotatedAt: null,
  revokedAt: null,
};

describe('classifyPresentedToken', () => {
  it('rotates a live token', () => {
    expect(classifyPresentedToken(live, NOW)).toEqual({ outcome: 'rotate' });
  });

  /**
   * The theft signal, and the only outcome that destroys more than the token
   * presented. A rotated row is a spent one: the legitimate client replaced it
   * and holds the successor, so a second presentation means two parties hold
   * the same secret and there is no way to tell which one is asking.
   */
  it('treats a token that was already rotated as replay', () => {
    expect(
      classifyPresentedToken({ ...live, rotatedAt: ago(60_000) }, NOW),
    ).toEqual({ outcome: 'replay' });
  });

  /**
   * Revocation is deliberate — a sign-out, or the eviction that a replay
   * triggered. Reporting it as replay would let one theft revoke the family
   * again on every subsequent attempt, which is noise rather than signal.
   */
  it('rejects a revoked token without calling it replay', () => {
    expect(
      classifyPresentedToken({ ...live, revokedAt: ago(60_000) }, NOW),
    ).toEqual({ outcome: 'reject', reason: 'revoked' });
  });

  /**
   * Ordering matters: a revoked *and* rotated row is the ordinary aftermath of
   * eviction, not a fresh theft. Checking rotation first would report every
   * post-eviction retry as a new compromise.
   */
  it('prefers revoked over replay when a row is both', () => {
    expect(
      classifyPresentedToken(
        { ...live, rotatedAt: ago(120_000), revokedAt: ago(60_000) },
        NOW,
      ),
    ).toEqual({ outcome: 'reject', reason: 'revoked' });
  });

  it('rejects a token past its sliding window', () => {
    expect(classifyPresentedToken({ ...live, expiresAt: ago(1) }, NOW)).toEqual(
      { outcome: 'reject', reason: 'expired' },
    );
  });

  /**
   * The cap is what makes the sliding window finite. Without it, a session
   * refreshed every 29 days never ends.
   */
  it('rejects a token whose family has hit the absolute cap, however fresh', () => {
    expect(
      classifyPresentedToken({ ...live, familyExpiresAt: ago(1) }, NOW),
    ).toEqual({ outcome: 'reject', reason: 'family_expired' });
  });

  it('accepts a token expiring in the very next instant', () => {
    expect(
      classifyPresentedToken({ ...live, expiresAt: ahead(1) }, NOW),
    ).toEqual({ outcome: 'rotate' });
  });
});

describe('expiry windows', () => {
  it('slides thirty days from the moment of issue', () => {
    expect(slidingExpiryFor(NOW)).toEqual(ahead(SLIDING_WINDOW_MS));
    expect(SLIDING_WINDOW_MS).toEqual(30 * 24 * 60 * 60 * 1000);
  });

  it('caps a family ninety days from the sign-in that began it', () => {
    expect(familyExpiryFor(NOW)).toEqual(ahead(ABSOLUTE_LIFETIME_MS));
    expect(ABSOLUTE_LIFETIME_MS).toEqual(90 * 24 * 60 * 60 * 1000);
  });
});
