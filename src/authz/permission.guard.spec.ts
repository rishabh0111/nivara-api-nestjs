import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PRINCIPAL_KEY, PUBLIC_KEY } from '../auth/auth.guard';
import { AppException } from '../common/errors/app-exception';
import { RequestPrincipal } from '../auth/request-principal';
import { PermissionGuard } from './permission.guard';
import { Permission } from './permissions';
import {
  AUTHENTICATED_ONLY_KEY,
  PERMISSION_KEY,
} from './require-permission.decorator';

/**
 * The guard's whole job is a decision, so it is tested as one — no application,
 * no HTTP. What the wiring does (that this runs *after* authentication, on
 * every route) is a different claim, asserted end to end in
 * `test/authorization.int-spec.ts` where it can actually be wrong.
 */
const agent: RequestPrincipal = {
  kind: 'user',
  tenantId: '00000000-0000-0000-0000-00000000000a',
  userId: '00000000-0000-0000-0000-00000000000b',
  role: 'agent',
};

const admin: RequestPrincipal = { ...agent, role: 'admin' };

interface Metadata {
  [PUBLIC_KEY]?: boolean;
  [PERMISSION_KEY]?: Permission;
  [AUTHENTICATED_ONLY_KEY]?: boolean;
}

const contextWith = (
  metadata: Metadata,
  principal?: RequestPrincipal,
): { guard: PermissionGuard; context: ExecutionContext } => {
  const reflector = {
    getAllAndOverride: (key: string) => metadata[key as keyof Metadata],
  } as unknown as Reflector;

  const request: Record<string, unknown> = {};

  if (principal) request[PRINCIPAL_KEY] = principal;

  const context = {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;

  return { guard: new PermissionGuard(reflector), context };
};

const decide = (
  metadata: Metadata,
  principal?: RequestPrincipal,
): 'allowed' | AppException => {
  const { guard, context } = contextWith(metadata, principal);

  try {
    guard.canActivate(context);
    return 'allowed';
  } catch (error) {
    if (error instanceof AppException) return error;
    throw error;
  }
};

describe('the permission guard', () => {
  it('allows a principal holding the required permission', () => {
    expect(decide({ [PERMISSION_KEY]: 'ticket:read' }, agent)).toBe('allowed');
  });

  it('refuses a principal without it', () => {
    const refusal = decide({ [PERMISSION_KEY]: 'user:invite' }, agent);

    expect(refusal).toBeInstanceOf(AppException);
    expect((refusal as AppException).code).toBe('forbidden');
  });

  it('allows the same operation to a principal that does hold it', () => {
    expect(decide({ [PERMISSION_KEY]: 'user:invite' }, admin)).toBe('allowed');
  });

  /**
   * The fail-closed rule, and the reason this guard is worth having rather
   * than a check inside each handler: a new endpoint someone forgot to
   * annotate is refused, not published.
   */
  it('refuses an operation that declares no requirement at all', () => {
    const refusal = decide({}, admin);

    expect(refusal).toBeInstanceOf(AppException);
    expect((refusal as AppException).code).toBe('forbidden');
  });

  it('allows an operation that explicitly requires only authentication', () => {
    expect(decide({ [AUTHENTICATED_ONLY_KEY]: true }, agent)).toBe('allowed');
  });

  it('lets a public operation through — there is no principal to authorize', () => {
    expect(decide({ [PUBLIC_KEY]: true })).toBe('allowed');
  });

  /**
   * Only reachable if the guards ever ran in the wrong order. The honest
   * answer is 401: there is no principal, so there is nothing to have refused
   * on authority grounds, and answering 403 would tell a caller with no
   * credential that one would not have been enough.
   */
  it('answers unauthenticated when no principal was resolved', () => {
    const refusal = decide({ [PERMISSION_KEY]: 'ticket:read' });

    expect(refusal).toBeInstanceOf(AppException);
    expect((refusal as AppException).code).toBe('unauthenticated');
  });
});
