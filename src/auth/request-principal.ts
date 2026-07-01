import { UserRole } from '../generated/prisma/client';
import { Actor, TenantContext } from '../tenancy/tenant-context';

/**
 * Who is making this request, as resolved from a validated credential.
 *
 * Now genuinely the union it was shaped to become. Everything downstream —
 * tenant arming, authorization, attribution — was written against this shape
 * rather than against "the logged-in user", which is why a second principal
 * kind arrives without a second authorization path to drift out of sync with
 * the first. Service tokens add a third `kind` on the same terms.
 *
 * Every field here is server-determined. There is no constructor that reads a
 * request body, and there must never be one: `tenantId` is what arms row-level
 * security, so a caller able to influence it could select which tenant it acts
 * as.
 */
export type RequestPrincipal = StaffPrincipal | ContactPrincipal;

/** Internal staff, carrying the role their authority is derived from. */
export interface StaffPrincipal {
  kind: 'user';
  tenantId: string;
  userId: string;
  role: UserRole;
}

/**
 * The tenant's end customer, signed into the portal.
 *
 * Note what is absent: there is no `role`, because a Contact holds no staff
 * authority at all — not a lesser one. `permissionsFor()` answers the empty set
 * here, and that is not a degenerate case to be filled in later. A Contact's
 * reach is a row-ownership question ("which Tickets are mine"), answered by
 * row-level security against `contactId`, and adding a role to this arm would
 * be the first step toward a customer who is a weak agent.
 */
export interface ContactPrincipal {
  kind: 'contact';
  tenantId: string;
  contactId: string;
}

/**
 * The bridge from a credential to a database context.
 *
 * This is the only sanctioned way to obtain a `TenantContext` for a request,
 * and that is the whole point: `withTenant()` will accept any well-formed
 * context, so the guarantee that request-scoped work runs under the *token's*
 * tenant lives here rather than in the discipline of each call site. A handler
 * reaching the database goes principal → context → `withTenant()`, and never
 * assembles a context from anything it was handed.
 *
 * The actor kind it arms is what the contact-axis policies read, so this
 * function is load-bearing in a way it was not when there was one kind of
 * principal: a Contact whose context armed `user` would see every Ticket in the
 * tenant. Derived from the principal's own discriminant rather than passed in,
 * so there is no call site that could arm the wrong one.
 */
export const tenantContextFor = (
  principal: RequestPrincipal,
): TenantContext => ({
  tenantId: principal.tenantId,
  actor: actorFor(principal),
});

/** The principal's discriminant, as the actor the audit trail records. */
const actorFor = (principal: RequestPrincipal): Actor =>
  principal.kind === 'user'
    ? { kind: 'user', id: principal.userId }
    : { kind: 'contact', id: principal.contactId };

/**
 * The context for work done *before* anyone is identified.
 *
 * Sign-in, refresh and sign-out all have to read the database in order to work
 * out who is asking — so there is no actor to name yet, and naming one would
 * mean asserting an identity from the unvalidated half of the request. That is
 * exactly the provenance lie the audit trail exists not to tell, and `system`
 * is the honest answer: the server did this on its own account.
 *
 * Separate from `tenantContextFor` rather than a default, because the two are
 * different claims and only one of them should ever be easy to reach for.
 */
export const systemContextFor = (tenantId: string): TenantContext => ({
  tenantId,
  actor: { kind: 'system' },
});
