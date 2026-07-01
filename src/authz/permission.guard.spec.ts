import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PRINCIPAL_KEY, PUBLIC_KEY } from '../auth/auth.guard';
import { AppException } from '../common/errors/app-exception';
import { RequestPrincipal } from '../auth/request-principal';
import { PermissionGuard } from './permission.guard';
import { PERMISSIONS, Permission } from './permissions';
import {
  AUTHENTICATED_ONLY_KEY,
  PERMISSION_KEY,
  PRINCIPAL_KIND_KEY,
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

const contact: RequestPrincipal = {
  kind: 'contact',
  tenantId: '00000000-0000-0000-0000-00000000000a',
  contactId: '00000000-0000-0000-0000-00000000000c',
};

interface Metadata {
  [PUBLIC_KEY]?: boolean;
  [PERMISSION_KEY]?: Permission;
  [AUTHENTICATED_ONLY_KEY]?: boolean;
  [PRINCIPAL_KIND_KEY]?: RequestPrincipal['kind'];
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

/**
 * The second axis, and the reason it is in this guard rather than a guard of
 * its own: there must remain exactly one place a request is authorized. A
 * separate portal guard would be a second authorization path, free to disagree
 * with this one about what a principal is — which is the drift the whole
 * `RequestPrincipal` normalization exists to prevent.
 *
 * The two axes are orthogonal and both are checked. An operation may name a
 * required kind, a required permission, or both; it may not name neither, which
 * is still the fail-closed case.
 */
describe('the principal-kind axis', () => {
  it('allows a contact into an operation that asks for one', () => {
    expect(decide({ [PRINCIPAL_KIND_KEY]: 'contact' }, contact)).toBe(
      'allowed',
    );
  });

  /**
   * The portal is not a surface staff use with fewer rows. A staff principal
   * has no `contactId`, so every portal handler would have to invent one — the
   * refusal is what keeps that question from arising.
   */
  it('refuses staff at a contact-only operation', () => {
    const refusal = decide({ [PRINCIPAL_KIND_KEY]: 'contact' }, admin);

    expect(refusal).toBeInstanceOf(AppException);
    expect((refusal as AppException).code).toBe('forbidden');
  });

  it('refuses a contact at a staff-only operation', () => {
    const refusal = decide({ [PRINCIPAL_KIND_KEY]: 'user' }, contact);

    expect(refusal).toBeInstanceOf(AppException);
    expect((refusal as AppException).code).toBe('forbidden');
  });

  /**
   * The checklist item this discharges at the guard layer: a Contact cannot
   * perform a staff operation. It holds no permission, so every
   * `@RequiresPermission` route in the API refuses it without any of those
   * routes having been told that Contacts exist.
   */
  it('refuses a contact at every permission-guarded operation', () => {
    for (const permission of PERMISSIONS) {
      const refusal = decide({ [PERMISSION_KEY]: permission }, contact);

      expect(refusal).toBeInstanceOf(AppException);
      expect((refusal as AppException).code).toBe('forbidden');
    }
  });

  /**
   * Both axes hold, and the kind check does not stand in for the permission
   * check. An operation asking for a staff principal *and* a grant that this
   * particular staff principal lacks is still refused.
   */
  it('applies both axes when an operation declares both', () => {
    expect(
      decide(
        { [PRINCIPAL_KIND_KEY]: 'user', [PERMISSION_KEY]: 'user:invite' },
        admin,
      ),
    ).toBe('allowed');

    const refusal = decide(
      { [PRINCIPAL_KIND_KEY]: 'user', [PERMISSION_KEY]: 'user:invite' },
      agent,
    );

    expect(refusal).toBeInstanceOf(AppException);
    expect((refusal as AppException).code).toBe('forbidden');
  });

  /**
   * A required kind is a complete authority decision on its own, so it
   * satisfies the fail-closed rule without `@AuthenticatedOnly()`. The portal's
   * operations are authorized by *being* a Contact plus row ownership, and
   * there is no permission for them to name.
   */
  it('counts a required kind as the operation having decided', () => {
    expect(decide({ [PRINCIPAL_KIND_KEY]: 'contact' }, contact)).toBe(
      'allowed',
    );
  });
});
