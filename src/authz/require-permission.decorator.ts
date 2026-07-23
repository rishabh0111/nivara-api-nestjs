import { CustomDecorator, SetMetadata, applyDecorators } from '@nestjs/common';
import { ApiExtension } from '@nestjs/swagger';
import { RequestPrincipal } from '../auth/request-principal';
import { Permission } from './permissions';

/** Where `PermissionGuard` reads an operation's requirement from. */
export const PERMISSION_KEY = 'authz:permission';

/** Where it reads the deliberate absence of one from. */
export const AUTHENTICATED_ONLY_KEY = 'authz:authenticated-only';

/** Where it reads an operation's required principal kind from. */
export const PRINCIPAL_KIND_KEY = 'authz:principal-kind';

/**
 * Declares the permission an operation requires.
 *
 * Two things at once, and on purpose: it is what the guard enforces *and* what
 * the OpenAPI document publishes as `x-required-permission`. Downstream repos
 * read that extension to map their tools onto endpoints, and deriving it from
 * the same decorator the guard reads means the published map cannot describe an
 * authority the server does not actually check — a hand-written annotation
 * would drift the first time a requirement changed.
 */
export const RequiresPermission = (
  permission: Permission,
): ReturnType<typeof applyDecorators> =>
  applyDecorators(
    SetMetadata(PERMISSION_KEY, permission),
    ApiExtension('x-required-permission', permission),
  );

/**
 * Declares which kind of principal an operation serves.
 *
 * The second authority axis, and a different question from `@RequiresPermission`
 * rather than a coarser version of it. A permission asks "may this caller do
 * this to any row it can see"; this asks "is this caller the sort of principal
 * this surface exists for at all".
 *
 * The portal needs it because a Contact holds no permissions by design — its
 * reach is row ownership, enforced beneath the application by row-level
 * security — so a portal route has no grant to name and would otherwise be
 * refused by the fail-closed rule. Staff routes use it where the *inverse*
 * matters: `GET /auth/me` reads a User row, and a Contact reaching it would be
 * asking for a row that does not describe them.
 *
 * Published as `x-required-principal-kind` for the same reason the permission is
 * published: a downstream repo mapping tools onto endpoints needs to know which
 * credential a given operation even accepts.
 */
export const RequiresPrincipalKind = (
  // Drawn from the union rather than re-spelled, so the `service` arm that
  // service tokens add becomes namable here the moment it exists — and so this list cannot
  // quietly fall behind the one the guard compares against.
  kind: RequestPrincipal['kind'],
): ReturnType<typeof applyDecorators> =>
  applyDecorators(
    SetMetadata(PRINCIPAL_KIND_KEY, kind),
    ApiExtension('x-required-principal-kind', kind),
  );

/**
 * Declares that an operation needs authentication and nothing further.
 *
 * The escape hatch from the guard's fail-closed rule, and deliberately a
 * verbose one. `GET /auth/me` genuinely has no permission to require — it
 * describes the caller to themselves, and there is no authority to hold over
 * your own identity — but "no requirement" and "nobody wrote a requirement"
 * must not look the same to the guard. This makes the first case explicit and
 * greppable, so the second stays a denial.
 */
export const AuthenticatedOnly = (): CustomDecorator =>
  SetMetadata(AUTHENTICATED_ONLY_KEY, true);
