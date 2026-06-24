import { CustomDecorator, SetMetadata, applyDecorators } from '@nestjs/common';
import { ApiExtension } from '@nestjs/swagger';
import { Permission } from './permissions';

/** Where `PermissionGuard` reads an operation's requirement from. */
export const PERMISSION_KEY = 'authz:permission';

/** Where it reads the deliberate absence of one from. */
export const AUTHENTICATED_ONLY_KEY = 'authz:authenticated-only';

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
