import { RequestPrincipal } from '../auth/request-principal';
import { UserRole } from '../generated/prisma/client';

/**
 * The closed vocabulary of authority in this API.
 *
 * Named permissions rather than role checks, and one table rather than a
 * `role === 'admin'` scattered across controllers: what an agent may do is a
 * question with an answer in one file, and changing that answer is one edit
 * with one diff to review.
 *
 * This same vocabulary is the scope namespace for service tokens — a scope is
 * a permission drawn from here, not a parallel set of names to keep in sync
 * (ticket 12). A permission added here is therefore a candidate scope, and
 * naming should read sensibly for a machine caller as well as a person.
 *
 * `resource:verb`, `snake`-free, stable. Permissions appear in the OpenAPI
 * document as `x-required-permission` and downstream repos map tools onto
 * them, so renaming one is a breaking change to a published contract.
 */
export const PERMISSION_CATALOG = {
  // --- Support work --------------------------------------------------------
  'ticket:read': 'Read Tickets and their conversation.',
  'ticket:create': 'Open a Ticket on a Contact’s behalf.',
  'ticket:reply': 'Post a customer-visible Message on a Ticket.',
  'ticket:transition': 'Move a Ticket between states.',
  'ticket:assign': 'Set or clear a Ticket’s assignee.',
  'ticket:priority': 'Change a Ticket’s priority.',
  'note:read': 'Read internal Notes, which are never visible to a Contact.',
  'note:write': 'Write an internal Note on a Ticket.',
  'contact:read': 'Read Contact records.',
  'analytics:read': 'Read the tenant’s analytics.',
  'user:read': 'List the tenant’s staff — the assignee picker needs this.',

  // --- Tenant configuration and destructive operations ---------------------
  // Separate from `ticket:transition` because it is a different kind of act:
  // every other transition is reversible, and `closed` is terminal — no
  // transition leads out of it, and a later reply opens a new Ticket rather
  // than reviving this one. It is the only transition whose authority depends
  // on the destination, which is why the check is in `TicketService` rather
  // than on the route: one endpoint serves every transition, and a route-level
  // grant could not tell them apart.
  'ticket:close': 'End a Ticket for good. Terminal and not reversible.',
  'ticket:delete': 'Hard-delete a Ticket and its conversation.',
  'user:invite': 'Invite a staff member into the tenant.',
  'user:deactivate': 'Deactivate a staff member and evict their sessions.',
  'sla:configure': 'Change the tenant’s SLA policy.',
  'token:manage': 'Mint, list, and revoke ServiceTokens.',
  'audit:read': 'Read the tenant’s audit log.',
} as const satisfies Record<string, string>;

export type Permission = keyof typeof PERMISSION_CATALOG;

export const PERMISSIONS = Object.keys(PERMISSION_CATALOG) as Permission[];

/**
 * The support half of the vocabulary — everything an agent does all day.
 *
 * Named separately so the admin grant can be written as "this, plus tenant
 * configuration". Spelling both lists out in full is how they drift: a
 * permission added to support work would have to be remembered in two places,
 * and the day it is not, admins quietly lose the ability to do the job they
 * supervise.
 */
const SUPPORT_WORK = [
  'ticket:read',
  'ticket:create',
  'ticket:reply',
  'ticket:transition',
  'ticket:assign',
  'ticket:priority',
  'note:read',
  'note:write',
  'contact:read',
  'analytics:read',
  'user:read',
] as const satisfies readonly Permission[];

/**
 * Role to permissions, statically and in one place.
 *
 * Deliberately not database-driven: per-tenant custom roles are a different
 * product, and a policy that lives in code is one a reviewer can read and a
 * test can assert against. The two roles are the whole model — a Contact is
 * not here at all, because customer access is a row-ownership axis enforced by
 * row-level security rather than a set of permissions.
 */
export const ROLE_PERMISSIONS = {
  agent: [...SUPPORT_WORK],
  admin: [
    ...SUPPORT_WORK,
    'ticket:close',
    'ticket:delete',
    'user:invite',
    'user:deactivate',
    'sla:configure',
    'token:manage',
    'audit:read',
  ],
} as const satisfies Record<UserRole, readonly Permission[]>;

/**
 * What a principal may do.
 *
 * The one place authority is derived, and the seam service tokens arrive
 * through: a token principal will answer from the permission set on its own
 * row rather than through a role, and the guard above will not notice the
 * difference. Keeping the branch here rather than in the guard is what makes
 * "one authorization path" true rather than aspirational.
 *
 * A Contact takes the empty branch, and the emptiness is the design rather than
 * a gap waiting to be filled. Customer access is a row-ownership axis — "which
 * Tickets are mine", answered by row-level security against `contactId` — and
 * not a smaller pile of the same grants staff hold. Anything a Contact can do
 * is reached through the portal surface, which is authorized by principal
 * *kind*; a permission granted here would instead let a Contact do that thing to
 * any Ticket in the tenant, which is precisely the collapse of the two axes the
 * model exists to prevent.
 */
export const permissionsFor = (
  principal: RequestPrincipal,
): ReadonlySet<Permission> => {
  if (principal.kind !== 'user') return EMPTY;

  // `?? []` rather than an index that trusts the map to be total. A role the
  // map does not cover — a token minted before an enum value was retired —
  // must resolve to *no* authority, not to an exception. Throwing here would
  // surface as a 500 and, worse, would be the one path in the request that
  // fails open in spirit: an unhandled error is not a refusal anybody audited.
  return new Set(ROLE_PERMISSIONS[principal.role] ?? []);
};

/**
 * Shared because it is immutable and every non-staff principal resolves to it.
 * `ReadonlySet` is the return type, so a caller has no supported way to mutate
 * this into a grant.
 */
const EMPTY: ReadonlySet<Permission> = new Set<Permission>();
