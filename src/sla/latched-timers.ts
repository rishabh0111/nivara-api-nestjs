import { SlaTimer } from '../realtime/events';

/** The two latch columns as the breach `UPDATE` returns them. */
export interface LatchedRow {
  id: string;
  firstResponseBreachedAt: Date | null;
  resolutionBreachedAt: Date | null;
}

/**
 * Which of a Ticket's two timers this sweep just latched.
 *
 * The breach `UPDATE` writes both columns in one statement — one may be newly
 * set, the other may have been latched weeks ago — and Postgres 17's `RETURNING`
 * can only see the new row, so it cannot say which. Rather than split the
 * statement in two and give up the single-scan property, the sweep passes one
 * timestamp for the whole tick and reads the answer back off the values: a latch
 * equal to that instant is one this statement wrote.
 *
 * That works because the latches are set-once. A column already holding a value
 * is coerced back to it by the state-machine trigger, so no second write can
 * ever land on the same instant, and the equality cannot produce a false
 * positive no matter how many ticks race.
 *
 * A pure function taking the instant rather than reading a clock, because "was
 * this written by the statement I just ran" is a question with a definite answer
 * and no dependence on when it is asked.
 */
export const latchedTimers = (row: LatchedRow, at: Date): SlaTimer[] => {
  const timers: SlaTimer[] = [];

  if (row.firstResponseBreachedAt?.getTime() === at.getTime()) {
    timers.push('first_response');
  }

  if (row.resolutionBreachedAt?.getTime() === at.getTime()) {
    timers.push('resolution');
  }

  return timers;
};
