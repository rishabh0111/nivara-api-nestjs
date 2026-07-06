import { isStaff, RealtimePrincipal } from './realtime-principal';
import { parseRoom } from './rooms';

/**
 * What the gate can answer without touching a database.
 *
 * Three outcomes rather than a boolean, and the third is the whole reason this
 * function stays pure. Every rule on this surface except one is decidable from
 * the principal and the room name alone; the exception — "is this the Ticket
 * this customer actually requested?" — is a fact about a row. Returning a
 * *verdict* instead of a promise keeps the rules that are pure testable without
 * a database, and confines the one query to the caller that already has a
 * transaction.
 *
 * `requires-requester-match` is deliberately not a soft yes. The gateway must
 * resolve it before joining, and it resolves it by reading the Ticket under the
 * principal's own tenant context — so row-level security answers it, and the
 * socket layer never has to reimplement the ownership predicate the database
 * already enforces on every REST read.
 */
export type JoinVerdict = 'allow' | 'deny' | 'requires-requester-match';

/**
 * Whether this principal may subscribe to this room.
 *
 * The room name is client input and is treated as such: it is parsed, not
 * trusted, and the tenant used for comparison comes from the *name* on one side
 * and the *token* on the other. Nothing here reads a tenant the client supplied
 * separately, which is what makes cross-tenant subscription impossible by
 * construction — there is no argument a client could send that changes which
 * tenant it is compared against.
 *
 * The tenant check comes first and applies to every principal kind alike. That
 * ordering matters for what the refusals reveal: a staff member of Meridian
 * asking for Sortwood's internal room is refused for being in the wrong tenant,
 * not for the room being internal, so the answer carries nothing about whether
 * that Ticket exists.
 *
 * The staff/customer split below is an axis, not a ladder. Staff reach every
 * room in their tenant because triage means looking at work that is not yours;
 * a customer reaches exactly one room per Ticket they requested. Neither is a
 * weaker version of the other, which is why there is no permission consulted
 * anywhere in this file — a `Permission` would imply an admin could be granted
 * the customer's view, and that is not a grant, it is a different question.
 */
export const canJoin = (
  principal: RealtimePrincipal,
  roomName: string,
): JoinVerdict => {
  const room = parseRoom(roomName);

  // Not a room this server names. Refused identically to a forbidden one,
  // because telling the two apart would describe the room grammar to whoever is
  // probing it — and the grammar is how the tenant boundary is expressed.
  if (!room) return 'deny';

  if (room.tenantId !== principal.tenantId) return 'deny';

  if (isStaff(principal)) return 'allow';

  // Everything below is the customer axis: a widget visitor or a signed-in
  // Contact.

  // The dashboard firehose carries every Ticket in the tenant, so there is no
  // version of it a customer could be shown.
  if (room.kind === 'agents') return 'deny';

  // The primary Note barrier, and the reason it is worth having two: this is a
  // refusal a customer cannot argue with, get around by owning the Ticket, or
  // reach through any subscribe argument. The audience filter in `events.ts`
  // exists to catch the *emit* that mis-routes a Note, not this.
  if (room.kind === 'internal') return 'deny';

  // A visitor with no Contact resolved yet falls through here rather than being
  // denied outright, and the distinction is invisible from outside: they have
  // requested no Tickets, so the ownership read finds nothing and the join is
  // refused a moment later. Denying early would be the same answer reached by
  // reasoning about a null, and this way there is one rule — "you may join the
  // room of a Ticket you requested" — rather than that rule plus a special case.
  return 'requires-requester-match';
};
