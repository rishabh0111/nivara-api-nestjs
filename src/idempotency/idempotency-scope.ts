import { principalRef } from '../auth/principal-ref';
import {
  RequestPrincipal,
  systemContextFor,
  tenantContextFor,
} from '../auth/request-principal';
import { TenantContext } from '../tenancy/tenant-context';

/**
 * The partition an HTTP caller's idempotency records live in.
 *
 * Two jobs, and both are load-bearing. It names the *request* — so a key reused
 * across two endpoints raises two unrelated claims rather than one confused one
 * — and it names the *caller*, which is what stops one principal reading back
 * another's cached response body. The second job is the reason this is a scope
 * rather than just a route: with the principal inside the key, "a caller can
 * only reach its own records" is a property of the unique index instead of a
 * filter that some future query has to remember.
 *
 * The concrete path, not the route template. `POST /tickets/a/messages` and
 * `POST /tickets/b/messages` are different requests, and collapsing them onto
 * `/tickets/:id/messages` would let a key legitimately reused on the second be
 * answered with the first's response.
 *
 * Every input is server-determined: the principal comes from a validated
 * credential and the path from the router. Nothing here can be steered by a
 * request body or a header, which is the same rule tenant identity follows.
 */
export const httpScope = (
  principal: RequestPrincipal,
  method: string,
  path: string,
): string => `${principalRef(principal)}|${method} ${path}`;

/**
 * The context an idempotency record is written under.
 *
 * `tenantContextFor()` for every principal that can name an actor, so a record
 * is attributed to whoever claimed it like every other row in this schema.
 *
 * The exception is the case above: a widget visitor with no Contact yet cannot
 * name an actor at all, and `tenantContextFor()` would rightly throw rather than
 * invent one. `system` is the honest answer and the same one sign-in uses — the
 * server did this on its own account, because the request that gives this
 * visitor an identity is the very request being guarded. Nothing rests on the
 * actor here: isolation comes from the session in the scope, and the actor
 * columns on this table are attribution rather than enforcement.
 */
export const idempotencyContextFor = (
  principal: RequestPrincipal,
): TenantContext =>
  principal.kind === 'widget' && principal.contactId === null
    ? systemContextFor(principal.tenantId)
    : tenantContextFor(principal);
