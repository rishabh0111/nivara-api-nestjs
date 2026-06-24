/**
 * What a presented invitation means, decided without a database.
 *
 * The same split `refresh-token-lifecycle.ts` makes, for the same reason: the
 * cases worth being sure about — a spent invitation, an aged-out one — are
 * awkward to stage against live rows and trivial to state as data.
 */

/**
 * Seven days. Long enough that an invitation survives a holiday, short enough
 * that a link forwarded into an archived inbox is not a standing offer of
 * tenant membership.
 */
export const INVITATION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export const invitationExpiryFor = (now: Date): Date =>
  new Date(now.getTime() + INVITATION_WINDOW_MS);

/** The fields the verdict turns on — a structural subset of the row. */
export interface PresentedInvitation {
  expiresAt: Date;
  acceptedAt: Date | null;
}

export type InvitationVerdict =
  /** Set the password and spend the invitation. */
  | { outcome: 'accept' }
  /**
   * Unusable. The reason never reaches the invitee — they are unauthenticated,
   * and which of the two it is describes the state of someone's account to
   * whoever holds the link. It exists for the server's logs.
   */
  | { outcome: 'reject'; reason: 'accepted' | 'expired' };

/**
 * Acceptance is checked before expiry, so a spent invitation that later ages
 * out still reads as spent. The two are different operator answers: one seat
 * is filled, the other is waiting on a reissue.
 */
export const classifyInvitation = (
  invitation: PresentedInvitation,
  now: Date,
): InvitationVerdict => {
  if (invitation.acceptedAt) return { outcome: 'reject', reason: 'accepted' };
  if (invitation.expiresAt <= now)
    return { outcome: 'reject', reason: 'expired' };

  return { outcome: 'accept' };
};
