// `import type`, because `permissions.ts` imports this module back for the
// principal union. The cycle is real but purely at the type level, and this
// keeps it erased rather than leaving a runtime edge for the module loader to
// resolve in whichever order it happens to reach the two files.
import type { Permission } from '../authz/permissions';
import { UserRole } from '../generated/prisma/client';
import {
  Actor,
  InvalidTenantContextError,
  TenantContext,
} from '../tenancy/tenant-context';

/**
 * Who is making this request, as resolved from a validated credential.
 *
 * Now genuinely the union it was shaped to become. Everything downstream —
 * tenant arming, authorization, attribution — was written against this shape
 * rather than against "the logged-in user", which is why a second principal
 * kind arrives without a second authorization path to drift out of sync with
 * the first. Service tokens arrived on exactly those terms as the fourth arm
 * below, adding a credential type and no second authorization path.
 *
 * Every field here is server-determined. There is no constructor that reads a
 * request body, and there must never be one: `tenantId` is what arms row-level
 * security, so a caller able to influence it could select which tenant it acts
 * as.
 */
export type RequestPrincipal =
  StaffPrincipal | ContactPrincipal | WidgetPrincipal | ServicePrincipal;

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
 * An anonymous visitor on the tenant's own site, holding a widget session.
 *
 * The third arm, and the only one whose subject may not exist yet. A Contact is
 * resolved when one is actually *needed* — opening a Ticket needs a requester,
 * reading a list of Tickets does not — so `contactId` is null for a visitor who
 * has opened the widget and not yet said anything.
 *
 * That nullability is confined here on purpose. Nothing downstream branches on
 * it, because nothing downstream ever sees this principal: the widget surface
 * exchanges it for a `ContactPrincipal` through `WidgetSessionService` before it
 * touches a Ticket or a Message, and from that point the request is
 * indistinguishable from a portal request. So the widget adds a credential type
 * and a surface, and adds no second implementation of anything — which is why a
 * widget visitor is narrowed by exactly the row-level security policies the
 * portal is, rather than by a parallel set somebody has to keep in step.
 *
 * `sessionId` is carried rather than discarded because it is what renewal
 * extends and what revocation kills — the row is the mutable half of the
 * session, and this is the handle on it.
 */
export interface WidgetPrincipal {
  kind: 'widget';
  tenantId: string;
  sessionId: string;
  /** Null until an act requires a requester. See `WidgetSessionService`. */
  contactId: string | null;
}

/**
 * Software acting within a tenant under an admin's explicit authority.
 *
 * The only arm carrying its authority *in* the principal rather than deriving
 * it from a role, and that asymmetry is deliberate: a role is a name for a set
 * of grants shared by many people, whereas a service token's grants are chosen
 * one integration at a time. `permissionsFor()` reads this field where it reads
 * `ROLE_PERMISSIONS` for staff, and the guard above cannot tell the difference —
 * which is what makes "one authorization path" true rather than aspirational.
 *
 * Resolved fresh from the row on every request, never from the token. That is
 * the whole reason this credential is not a JWT: scopes an admin widened a
 * moment ago apply now, and a revoked token stops working on its very next
 * request rather than whenever a signed copy of the truth expires.
 *
 * An agent-equivalent principal, and therefore exempt from the Contact axis: it
 * arms the `service` actor kind, so the `NOT current_actor_is_contact()` clause
 * in every contact-axis policy passes it through exactly as it does staff. No
 * policy needed a `service` case written into it, which is the same dividend
 * the widget's decision to arm `contact` paid.
 */
export interface ServicePrincipal {
  kind: 'service';
  tenantId: string;
  /** The `service_token` row this credential names — the audit trail's actor. */
  tokenId: string;
  /**
   * What this token may do, already narrowed by `grantedScopes()`. Carried as
   * `Permission[]` rather than `string[]` so the un-grantable set cannot be
   * smuggled in by a row somebody wrote outside the mint path.
   */
  scopes: readonly Permission[];
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

/**
 * The principal's discriminant, as the actor the audit trail records.
 *
 * A widget session arms `contact`, not an actor kind of its own, and that is
 * the single decision the whole widget surface rests on. There is no `widget`
 * actor kind: a widget visitor *is* a Contact — one who has not said who they
 * are — so every policy already written on the contact axis narrows them
 * identically, and every audit row already attributes them correctly. A fourth
 * actor kind would have meant revisiting each of those policies to decide what
 * it means there, and the honest answer at each would have been "the same as a
 * contact".
 *
 * A widget principal with no Contact yet has no actor to name, and that is a
 * programming error rather than a state to handle: the surface exchanges such a
 * principal for a `ContactPrincipal` before reaching the database. Throwing
 * `InvalidTenantContextError` is the same treatment every other unarmable
 * context gets — a 500 naming the missing step, rather than a silently
 * mis-attributed write.
 */
const actorFor = (principal: RequestPrincipal): Actor => {
  if (principal.kind === 'user') return { kind: 'user', id: principal.userId };

  if (principal.kind === 'contact') {
    return { kind: 'contact', id: principal.contactId };
  }

  // A `service` actor kind of its own, unlike the widget's decision to arm
  // `contact`. The two cases look alike and are not: a widget visitor *is* a
  // Contact who has not said who they are, so every contact-axis policy already
  // meant the right thing for them. A machine caller is not a User — it is a
  // fourth thing that acts — and the whole point of attributing it separately is
  // that AI contribution is measurable. Arming `user` would have made deflection
  // unanswerable by hiding every machine Message among the human ones.
  if (principal.kind === 'service') {
    return { kind: 'service', id: principal.tokenId };
  }

  if (!principal.contactId) {
    throw new InvalidTenantContextError(
      `widget session ${principal.sessionId} has not resolved a Contact — call WidgetSessionService.contactPrincipalFor() before reaching the database`,
    );
  }

  return { kind: 'contact', id: principal.contactId };
};

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
