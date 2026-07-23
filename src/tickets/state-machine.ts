import { Permission } from '../authz/permissions';
import { TicketState } from '../generated/prisma/client';

/**
 * Who may trigger a transition — the one dimension of the state machine that
 * cannot live in the database.
 *
 * Enforcement is split deliberately, and this file is the small half. From-to
 * legality is a trigger on `ticket`, so an illegal move is impossible through
 * *any* write path — this API, the Spring and FastAPI ports, a scheduled job, a
 * psql session. Reimplementing that table here would create a second source of
 * truth that can pass its own unit tests while disagreeing with the one that
 * decides.
 *
 * What is left is the authority question, and it is here because it needs the
 * credential, which SQL does not have.
 *
 * The parameter is a permission set rather than a role, which is the repo's
 * standing rule (`src/authz/permissions.ts`) and matters twice here. A
 * ServiceToken carries scopes and no role at all, so a `role === 'admin'` test
 * would misjudge the AI layer the moment service tokens land; and a scheduler
 * closing Tickets on a dwell timer has no User behind it either.
 * Both hold permissions, so both compose with this without a second
 * authorization path being invented for them.
 *
 * So this function is deliberately *permissive* about pairs. It says nothing
 * about whether `open → closed` is a legal move; it says only that if such a
 * move were attempted, it would take `ticket:close`. The trigger answers the
 * other half.
 */
export const canTransition = (
  // Unread today. Kept because "who may trigger this" is a question about a
  // move, and a move is the pair — a guard that took only the destination would
  // be answering a different question than its name claims.
  _from: TicketState,
  to: TicketState,
  permissions: ReadonlySet<Permission>,
): boolean => {
  // Closing is the only transition with an authority attached, and the
  // asymmetry is real rather than ceremonial: `closed` is hard-terminal — no
  // transition leads out of it, and a later Contact reply spawns a fresh Ticket
  // instead of reviving this one. Everything else an agent does is
  // reversible; this is not.
  if (to === TicketState.closed) return permissions.has('ticket:close');

  return true;
};
