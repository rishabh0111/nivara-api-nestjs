import { Permission, ROLE_PERMISSIONS } from '../authz/permissions';
import { TicketState, UserRole } from '../generated/prisma/client';
import { canTransition } from './state-machine';

/**
 * The authority dimension of the state machine, and only that.
 *
 * Which `from → to` pairs are legal at all is not asserted here, because it is
 * not decided here: the `BEFORE UPDATE` trigger owns the transition table so
 * that every port inherits it, and a table duplicated in TypeScript would be a
 * second source of truth that passes its own tests while disagreeing with the
 * database. What this module decides is *who may trigger* a transition, which
 * needs the credential and therefore cannot live in SQL.
 *
 * The cases are driven off `ROLE_PERMISSIONS` rather than off literal sets, so
 * a permission moved between the roles fails here rather than quietly changing
 * what the machine allows.
 */
describe('canTransition', () => {
  const ACTIVE = [
    TicketState.open,
    TicketState.pending,
    TicketState.on_hold,
  ] as const;

  const heldBy = (role: UserRole): ReadonlySet<Permission> =>
    new Set(ROLE_PERMISSIONS[role]);

  const admin = heldBy(UserRole.admin);
  const agent = heldBy(UserRole.agent);

  describe('closing', () => {
    it('lets a holder of ticket:close close a resolved Ticket', () => {
      expect(
        canTransition(TicketState.resolved, TicketState.closed, admin),
      ).toBe(true);
    });

    /**
     * The one asymmetry between the roles. Closing is irreversible — nothing
     * moves a Ticket out of `closed`, and a later reply spawns a new Ticket
     * rather than reviving this one — so it is the one act reserved for the
     * role that supervises the queue rather than works it.
     */
    it('refuses a caller without it', () => {
      expect(agent.has('ticket:close')).toBe(false);
      expect(
        canTransition(TicketState.resolved, TicketState.closed, agent),
      ).toBe(false);
    });

    /**
     * The permission and nothing else. A principal with no role at all — a
     * ServiceToken, a scheduler — is judged the same way, which is what keeps
     * this from becoming a second authorization path when service tokens land.
     */
    it('asks for the permission rather than for a role', () => {
      expect(
        canTransition(
          TicketState.resolved,
          TicketState.closed,
          new Set<Permission>(['ticket:close']),
        ),
      ).toBe(true);

      expect(
        canTransition(
          TicketState.resolved,
          TicketState.closed,
          new Set<Permission>(['ticket:transition']),
        ),
      ).toBe(false);
    });

    /**
     * `open → closed` is illegal for everyone, but not *here*: this guard
     * answers the authority question and the trigger answers the legality one.
     * The two callers differ in which refusal they eventually receive, not in
     * whether they are refused.
     */
    it('does not pre-empt the trigger on a pair that is illegal for everyone', () => {
      expect(canTransition(TicketState.open, TicketState.closed, admin)).toBe(
        true,
      );
      expect(canTransition(TicketState.open, TicketState.closed, agent)).toBe(
        false,
      );
    });
  });

  describe('everything short of closing', () => {
    it('lets an agent move a Ticket between the active states', () => {
      for (const from of ACTIVE) {
        for (const to of ACTIVE) {
          expect(canTransition(from, to, agent)).toBe(true);
        }
      }
    });

    it('lets an agent resolve, and reopen what they resolved', () => {
      for (const from of ACTIVE) {
        expect(canTransition(from, TicketState.resolved, agent)).toBe(true);
      }

      expect(canTransition(TicketState.resolved, TicketState.open, agent)).toBe(
        true,
      );
    });

    /**
     * Only closing is gated, so nothing else is refused for want of a
     * permission — a caller holding none still passes this guard and meets the
     * trigger, and the route-level `ticket:transition` grant is what kept them
     * out before they ever got here.
     */
    it('gates no transition but closing', () => {
      const none = new Set<Permission>();

      for (const from of [...ACTIVE, TicketState.resolved]) {
        for (const to of [...ACTIVE, TicketState.resolved]) {
          expect(canTransition(from, to, none)).toBe(true);
        }
      }
    });
  });
});
