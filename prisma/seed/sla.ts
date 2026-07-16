import { TicketState } from '../../src/generated/prisma/client';
import { DaysAgo, ThreadEntry, Transition } from './plan';

/**
 * When a seeded Ticket's clocks ran out — derived, never declared.
 *
 * A plan that simply asserted "this one is breached" would produce a database
 * where the latch and the timeline disagree: run the sweep against it and either
 * nothing changes or Tickets breach that were already marked healthy, and either
 * way the demo is showing a state the application could not have reached. So the
 * breach instants are computed here from the same two rules the migration
 * defines, against the same targets the trigger seeded.
 *
 * The reward is that the seeded rows are a fixed point. `SlaSweep` can run over
 * this data on the first tick and find exactly the Tickets already latched, and
 * a developer can watch a fresh breach appear as a Ticket ages past its target
 * rather than being handed a queue that never changes.
 */

/** The tenant's targets for one priority, in milliseconds. */
export interface SlaTarget {
  firstResponseMs: number;
  resolutionMs: number;
}

/** The clock columns a Ticket carries once its history has been replayed. */
export interface SlaClocks {
  /** Closed pause intervals, summed. */
  pausedMs: number;
  /** The open pause interval, non-null exactly while the clock is stopped. */
  pauseStartedAt: Date | null;
  firstResponseBreachedAt: Date | null;
  resolutionBreachedAt: Date | null;
  lastActivityAt: Date;
}

/**
 * The states that stop the resolution clock, restated from the migration.
 *
 * `on_hold` is deliberately absent: an internal blocker is still the customer
 * waiting, and pausing for it would make the metric flattering rather than
 * useful.
 */
const STOPS_THE_CLOCK: readonly TicketState[] = [
  'pending',
  'resolved',
  'closed',
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** An offset in days before `now`, as an instant. */
export const at = (now: Date, daysAgo: DaysAgo): Date =>
  new Date(now.getTime() - daysAgo * DAY_MS);

export interface ReplayInput {
  now: Date;
  openedAt: Date;
  path: readonly Transition[];
  thread: readonly ThreadEntry[];
  target: SlaTarget;
}

/**
 * Replays a Ticket's history into the columns the database would hold.
 *
 * One walk rather than four passes, because the pause accumulator and the
 * resolution breach are the same traversal asking two questions — and a second
 * walk is how they would come to disagree about when the clock was running.
 */
export const replay = ({
  now,
  openedAt,
  path,
  thread,
  target,
}: ReplayInput): SlaClocks => {
  const segments = timeline(now, openedAt, path);

  let pausedMs = 0;
  let pauseStartedAt: Date | null = null;
  let activeMs = 0;
  let resolutionBreachedAt: Date | null = null;

  for (const segment of segments) {
    const spanMs = segment.until.getTime() - segment.from.getTime();

    if (STOPS_THE_CLOCK.includes(segment.state)) {
      // The last segment's pause is still open — it is what the Ticket is doing
      // right now — so it stays out of the accumulator and becomes the column
      // instead. That is exactly the split the trigger maintains.
      if (segment.open) pauseStartedAt = segment.from;
      else pausedMs += spanMs;

      continue;
    }

    // The resolution clock ran through this segment. If the target fell inside
    // it, the latch belongs at that instant rather than at the segment's end:
    // the sweep would have caught it on the next tick, and dating it later would
    // make a Ticket look like it breached when somebody finally touched it.
    if (
      resolutionBreachedAt === null &&
      activeMs + spanMs > target.resolutionMs
    )
      resolutionBreachedAt = new Date(
        segment.from.getTime() + (target.resolutionMs - activeMs),
      );

    activeMs += spanMs;
  }

  return {
    pausedMs,
    pauseStartedAt,
    resolutionBreachedAt,
    firstResponseBreachedAt: firstResponseBreach(now, openedAt, thread, target),
    lastActivityAt: lastActivity(now, openedAt, path, thread),
  };
};

/** One stretch of time the Ticket spent in a single state. */
interface Segment {
  state: TicketState;
  from: Date;
  until: Date;
  /** Whether this is the segment the Ticket is still in. */
  open: boolean;
}

const timeline = (
  now: Date,
  openedAt: Date,
  path: readonly Transition[],
): Segment[] => {
  const segments: Segment[] = [];

  let state: TicketState = 'open';
  let from = openedAt;

  for (const move of path) {
    const until = at(now, move.daysAgo);

    segments.push({ state, from, until, open: false });
    state = move.to;
    from = until;
  }

  segments.push({ state, from, until: now, open: true });

  return segments;
};

/**
 * Wall-clock and unpausable, per the migration.
 *
 * Reaching `pending` with nobody having answered does not discharge the promise
 * to answer, so this asks one question: was there a customer-visible reply from
 * a person or the AI, and did it arrive inside the window. A Note is not a
 * reply — a team that could satisfy its response promise by writing to itself
 * has a metric that measures activity.
 */
const firstResponseBreach = (
  now: Date,
  openedAt: Date,
  thread: readonly ThreadEntry[],
  target: SlaTarget,
): Date | null => {
  const deadline = new Date(openedAt.getTime() + target.firstResponseMs);
  const responses = thread
    .filter((entry) => entry.by !== 'contact' && !entry.internal)
    .map((entry) => at(now, entry.daysAgo).getTime());

  const answeredAt = responses.length > 0 ? Math.min(...responses) : null;

  if (answeredAt !== null)
    return answeredAt > deadline.getTime() ? deadline : null;

  return now > deadline ? deadline : null;
};

/**
 * When anyone last did anything, for the dwell timers alone.
 *
 * Separate from `updated_at` because a customer's reply is activity and touches
 * no Ticket column. Notes count here and not above, which is the same
 * distinction stated from the other side: "has anyone answered" and "is anyone
 * working on this" are different questions.
 */
const lastActivity = (
  now: Date,
  openedAt: Date,
  path: readonly Transition[],
  thread: readonly ThreadEntry[],
): Date => {
  const instants = [
    openedAt.getTime(),
    ...path.map((move) => at(now, move.daysAgo).getTime()),
    ...thread.map((entry) => at(now, entry.daysAgo).getTime()),
  ];

  return new Date(Math.max(...instants));
};
