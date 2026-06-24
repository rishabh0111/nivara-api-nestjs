import {
  INVITATION_WINDOW_MS,
  classifyInvitation,
  invitationExpiryFor,
} from './invitation-lifecycle';

const now = new Date('2026-07-18T12:00:00.000Z');
const later = (ms: number) => new Date(now.getTime() + ms);

describe('the invitation window', () => {
  it('is seven days from issue', () => {
    expect(invitationExpiryFor(now)).toEqual(later(INVITATION_WINDOW_MS));
    expect(INVITATION_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe('classifying a presented invitation', () => {
  it('accepts a live, unspent invitation', () => {
    expect(
      classifyInvitation({ expiresAt: later(1000), acceptedAt: null }, now),
    ).toEqual({ outcome: 'accept' });
  });

  it('refuses one that has already been accepted', () => {
    expect(
      classifyInvitation({ expiresAt: later(1000), acceptedAt: now }, now),
    ).toEqual({ outcome: 'reject', reason: 'accepted' });
  });

  it('refuses one past its expiry', () => {
    expect(
      classifyInvitation({ expiresAt: later(-1), acceptedAt: null }, now),
    ).toEqual({ outcome: 'reject', reason: 'expired' });
  });

  it('treats the expiry instant itself as past', () => {
    expect(
      classifyInvitation({ expiresAt: now, acceptedAt: null }, now),
    ).toEqual({ outcome: 'reject', reason: 'expired' });
  });

  /**
   * Spent beats expired. Both refuse, so the ordering only shows up in the
   * reason — but an accepted invitation that later ages out is a used seat,
   * not an abandoned one, and reporting it as expired would invite an admin to
   * reissue a credential nobody is waiting for.
   */
  it('reports an accepted-then-expired invitation as accepted', () => {
    expect(
      classifyInvitation({ expiresAt: later(-1), acceptedAt: now }, now),
    ).toEqual({ outcome: 'reject', reason: 'accepted' });
  });
});
