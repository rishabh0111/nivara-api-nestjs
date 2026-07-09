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
 * A stable, server-side reference to whoever is retrying.
 *
 * Prefixed by kind, so a User and a Contact whose ids happened to collide are
 * still two callers. A widget visitor is keyed on the *session* rather than on
 * the Contact behind it, and that is the one genuinely considered choice here:
 * a visitor's first write is what creates their Contact, so the Contact is null
 * on the original request and present on the retry. Keying on it would put the
 * two attempts in different partitions and let the retry open a second Ticket —
 * the exact duplicate this module exists to prevent. The session is the identity
 * that spans both, which is what a widget session is for.
 */
const principalRef = (principal: RequestPrincipal): string => {
  switch (principal.kind) {
    case 'user':
      return `u:${principal.userId}`;
    case 'contact':
      return `c:${principal.contactId}`;
    case 'widget':
      return `w:${principal.sessionId}`;
    case 'service':
      return `s:${principal.tokenId}`;
  }
};

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
