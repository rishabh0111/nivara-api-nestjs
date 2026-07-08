import { latchedTimers } from './latched-timers';

const AT = new Date('2026-07-19T12:00:00.000Z');
const EARLIER = new Date('2026-07-12T09:30:00.000Z');

const row = (
  firstResponseBreachedAt: Date | null,
  resolutionBreachedAt: Date | null,
) => ({ id: 't1', firstResponseBreachedAt, resolutionBreachedAt });

describe('latchedTimers', () => {
  it('reports nothing when both latches predate this sweep', () => {
    // The row came back because the *other* predicate matched, or because a
    // concurrent tick got there first. Either way this sweep announces nothing.
    expect(latchedTimers(row(EARLIER, EARLIER), AT)).toEqual([]);
  });

  it('reports nothing when both latches are unset', () => {
    expect(latchedTimers(row(null, null), AT)).toEqual([]);
  });

  it('reports the timer whose latch equals this sweep’s instant', () => {
    expect(latchedTimers(row(AT, null), AT)).toEqual(['first_response']);
    expect(latchedTimers(row(null, AT), AT)).toEqual(['resolution']);
  });

  it('reports both when one statement latched both clocks at once', () => {
    // A Ticket left alone long enough to blow through both targets. Two audit
    // rows and two events, from one row and one scan.
    expect(latchedTimers(row(AT, AT), AT)).toEqual([
      'first_response',
      'resolution',
    ]);
  });

  it('distinguishes an old latch from a new one on the same row', () => {
    // The case the whole function exists for: a Ticket that breached first
    // response last week and has only now missed its resolution target. Exactly
    // one announcement is owed, and it is not the one already made.
    expect(latchedTimers(row(EARLIER, AT), AT)).toEqual(['resolution']);
  });

  it('compares by instant rather than by identity', () => {
    // The rows come back off the wire, so the Date is never the same object the
    // sweep passed in. A reference comparison would report nothing, ever.
    expect(latchedTimers(row(new Date(AT.getTime()), null), AT)).toEqual([
      'first_response',
    ]);
  });
});
