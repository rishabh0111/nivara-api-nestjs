import { Prisma, Ticket } from '../generated/prisma/client';

/**
 * How a conversation chain is addressed, in one place.
 *
 * The shape is small but it encodes the null-origin convention, and that
 * convention is exactly the kind of thing that goes wrong when it is spelled out
 * at each call site. `rootTicketId` is null on an origin Ticket — "I am the
 * root" — so every reader has to fold that back in, and a reader that forgot
 * would silently return a one-element chain for every conversation whose origin
 * it was handed.
 *
 * It lives with `Ticket` rather than with the reply path because a chain is a
 * fact about Tickets. The reply path is one of its two readers; the staff
 * conversation endpoint is the other.
 *
 * The third statement of the same rule is `COALESCE(root_ticket_id, id)` in the
 * linkage migration's unique index, and it cannot be shared with these — it is
 * SQL, and it has to be, because it is what holds the invariant for the Spring
 * and FastAPI ports too. Two statements of a convention with a comment on each
 * saying so is the honest cost of that; three would not have been.
 */

/** The origin of the chain this Ticket belongs to — itself, when it is the origin. */
export const chainRootOf = (ticket: Ticket): string =>
  ticket.rootTicketId ?? ticket.id;

/**
 * Every Ticket in this one's conversation, as a `where` clause.
 *
 * The origin matches by primary key and its descendants by
 * `(tenantId, rootTicketId, createdAt)`, so both halves of the `OR` are served
 * by an index. No recursion: that is what `rootTicketId` is denormalized for.
 */
export const inChainWith = (ticket: Ticket): Prisma.TicketWhereInput => {
  const root = chainRootOf(ticket);

  return { OR: [{ id: root }, { rootTicketId: root }] };
};
