import { UserRole } from '../generated/prisma/client';
import { TenantContext } from '../tenancy/tenant-context';

/**
 * Who is making this request, as resolved from a validated credential.
 *
 * Deliberately shaped as the one member of a union it will become. Service
 * tokens add a second `kind` and a second authentication branch, and
 * everything downstream
 * — tenant arming, authorization, attribution — is written against this shape
 * rather than against "the logged-in user". The normalization is built now, at
 * the point where there is nothing to normalize, precisely so there is never a
 * moment where a second authorization path exists to drift out of sync with
 * the first.
 *
 * Every field here is server-determined. There is no constructor that reads a
 * request body, and there must never be one: `tenantId` is what arms row-level
 * security, so a caller able to influence it could select which tenant it acts
 * as.
 */
export type RequestPrincipal = {
  kind: 'user';
  tenantId: string;
  userId: string;
  role: UserRole;
};

/**
 * The bridge from a credential to a database context.
 *
 * This is the only sanctioned way to obtain a `TenantContext` for a request,
 * and that is the whole point: `withTenant()` will accept any well-formed
 * context, so the guarantee that request-scoped work runs under the *token's*
 * tenant lives here rather than in the discipline of each call site. A handler
 * reaching the database goes principal → context → `withTenant()`, and never
 * assembles a context from anything it was handed.
 */
export const tenantContextFor = (
  principal: RequestPrincipal,
): TenantContext => ({
  tenantId: principal.tenantId,
  actor: { kind: 'user', id: principal.userId },
});

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
