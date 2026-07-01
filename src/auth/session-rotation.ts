import { Logger } from '@nestjs/common';
import { TenantClient } from '../tenancy/tenancy.service';
import { RefreshTokenService, SessionSubject } from './refresh-token.service';

/**
 * The rotation dance, once, for both access axes.
 *
 * `RefreshTokenService` already owns the parts that must not exist twice —
 * hashing, the conditional spend, family eviction. What was duplicated is the
 * *order* those are called in, and the order is where the security lives: check
 * the axis before acting on the verdict, treat replay as theft before treating
 * anything as valid, re-read the subject before minting, and only then rotate.
 * Two copies of that sequence would not fail loudly when they drifted; one would
 * simply stop revoking a family, or start minting from a row it had not
 * re-checked, and nothing would look wrong.
 *
 * What stays with each caller is what genuinely differs: which table holds the
 * subject, and what a principal for that axis looks like. Both arrive as one
 * `resolve` callback, so a surface cannot accidentally re-read the wrong table
 * for its own kind of token.
 */

export interface RotatedSession<P> {
  principal: P;
  refreshToken: string;
}

export interface RotationRequest<P> {
  refreshTokens: RefreshTokenService;
  tx: TenantClient;
  token: string;
  now: Date;
  /**
   * Which axis this endpoint serves.
   *
   * A token for the other axis is refused here — one ledger serves both, so
   * this is the point where "is this session mine to rotate" gets asked. It is
   * *not* treated as replay: presenting a valid token at the wrong door is a
   * client bug, and evicting the family for it would sign someone out of a
   * session they were using correctly elsewhere.
   */
  expect: SessionSubject['kind'];
  /**
   * Re-reads the subject and builds its principal, or `null` if it is gone.
   *
   * Re-read rather than trusted: the row may have been deleted, and on the
   * staff axis a role may have changed, inside the window the presented token
   * was valid for. Minting from the token's own claims would let a stale answer
   * survive indefinitely across a long-lived session.
   */
  resolve: (tx: TenantClient, subjectId: string) => Promise<P | null>;
  logger: Logger;
  /** Names the axis in the replay warning — 'Refresh' / 'Portal refresh'. */
  label: string;
  tenantId: string;
}

/**
 * Rotates a presented refresh token, or answers `null`.
 *
 * One `null` for every refusal — unrecognized, expired, revoked, replayed, the
 * wrong axis, a vanished subject, a lost race. The caller turns it into the
 * single `unauthenticated` error, because every distinction it could draw
 * instead is a fact about which tokens exist, offered to whoever asked without
 * a valid one.
 */
export const rotateRefreshSession = async <P>({
  refreshTokens,
  tx,
  token,
  now,
  expect,
  resolve,
  logger,
  label,
  tenantId,
}: RotationRequest<P>): Promise<RotatedSession<P> | null> => {
  const found = await refreshTokens.classify(tx, token, now);

  if ('outcome' in found) return null;

  const { verdict, subject, familyId } = found;

  if (subject.kind !== expect) return null;

  const subjectId =
    subject.kind === 'user' ? subject.userId : subject.contactId;

  if (verdict.outcome === 'replay') {
    await refreshTokens.revokeFamily(tx, familyId, now);

    // Worth a log line where the other refusals are not: this one says a token
    // was held by two parties, which is a security event rather than an expired
    // session.
    logger.warn(
      `${label} token replay detected; revoked family ${familyId} for ${subject.kind} ${subjectId} in tenant ${tenantId}.`,
    );

    return null;
  }

  if (verdict.outcome === 'reject') return null;

  const principal = await resolve(tx, subjectId);

  if (!principal) return null;

  const rotated = await refreshTokens.rotate(tx, { token, now });

  // Lost the race two concurrent refreshes create: the winner spent the token,
  // and this caller's retry will read a spent row, which is the replay path.
  if (!rotated) return null;

  return { principal, refreshToken: rotated.token };
};
