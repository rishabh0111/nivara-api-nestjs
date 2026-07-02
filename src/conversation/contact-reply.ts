import { TicketState } from '../generated/prisma/client';

/**
 * What a Contact's reply does to the Ticket it lands on.
 *
 * A customer should not have to ask twice to be heard, and a reply to old
 * history should not revive it. Those two sentences are the whole of this
 * table, and it is a pure function of the Ticket's state so that the rule can
 * be read, tested and ported without a database or a request in scope.
 *
 * Deliberately *not* a database trigger, unlike the transition table it feeds.
 * A trigger sees the rows, and this decision needs what the rows do not carry:
 * which channel the reply arrived on, and the reply's body, which becomes the
 * spawned Ticket's first Message. Build ticket 18 settled the split the same way —
 * spawn *creation* is application logic; the *immutability* of what it writes is
 * schema-level.
 */
export type ReplyOutcome =
  /** Post the Message and leave the Ticket where it is. */
  | 'append'
  /** Move the Ticket back to `open`, then post the Message on it. */
  | 'reopen'
  /** Start a linked Ticket with a fresh clock, and post the Message there. */
  | 'spawn';

/**
 * The mapping, exhaustively.
 *
 * A `switch` over the enum with no `default`, so adding a sixth state is a
 * compile error here rather than a silent `append` — the failure mode of a
 * lookup table with a fallback is that a new state quietly inherits the
 * behaviour of the old ones, and this table's whole job is to say that
 * different states behave differently.
 */
export const replyOutcomeFor = (state: TicketState): ReplyOutcome => {
  switch (state) {
    // Live work. The reply is another turn in a conversation already underway.
    case TicketState.open:
      return 'append';

    // Parked on something that is not the customer — a third party, a fix in
    // flight. A customer chasing it does not make that dependency resolve, so
    // reopening here would report progress that has not happened and would move
    // the Ticket out from under the agent who parked it.
    case TicketState.on_hold:
      return 'append';

    // Waiting on the customer. The reply is precisely the thing being waited
    // for, so the wait is over.
    case TicketState.pending:
      return 'reopen';

    // The agent believed this was done and the customer disagrees, which is the
    // clearest possible signal that it was not. `resolved` is soft-terminal for
    // exactly this reason.
    case TicketState.resolved:
      return 'reopen';

    // Hard-terminal. Nothing leads out of `closed`, so the reply gets a fresh
    // Ticket with a fresh SLA clock rather than reviving a record that was
    // finished — and the linkage keeps the history reachable, so "fresh" does
    // not mean "context lost".
    case TicketState.closed:
      return 'spawn';
  }
};
