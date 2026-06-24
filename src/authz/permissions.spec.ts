import { UserRole } from '../generated/prisma/client';
import {
  PERMISSIONS,
  PERMISSION_CATALOG,
  Permission,
  ROLE_PERMISSIONS,
  permissionsFor,
} from './permissions';

/**
 * The role map is data, so these are assertions about data — which is the
 * point of expressing authority as a table rather than as branches scattered
 * through controllers. Every property below would otherwise be a code review
 * someone has to remember to do.
 */
describe('the permission vocabulary', () => {
  it('describes every permission it names', () => {
    for (const permission of PERMISSIONS) {
      expect(PERMISSION_CATALOG[permission]).toEqual(expect.any(String));
    }
  });

  it('names permissions as `resource:verb`', () => {
    for (const permission of PERMISSIONS) {
      expect(permission).toMatch(/^[a-z]+:[a-z]+$/);
    }
  });
});

describe('the static role map', () => {
  it('covers every role', () => {
    expect(Object.keys(ROLE_PERMISSIONS).sort()).toEqual(
      Object.values(UserRole).sort(),
    );
  });

  /**
   * Admin is agent plus tenant configuration, not a different job. A
   * permission an agent holds and an admin does not would mean an admin has to
   * keep a second account to do support work.
   */
  it('gives an admin everything an agent has', () => {
    for (const permission of ROLE_PERMISSIONS.agent) {
      expect(ROLE_PERMISSIONS.admin).toContain(permission);
    }
  });

  it('reserves configuration and destructive authority to admins', () => {
    const adminOnly: Permission[] = [
      'ticket:delete',
      'user:invite',
      'user:deactivate',
      'sla:configure',
      'token:manage',
      'audit:read',
    ];

    for (const permission of adminOnly) {
      expect(ROLE_PERMISSIONS.admin).toContain(permission);
      expect(ROLE_PERMISSIONS.agent).not.toContain(permission);
    }
  });

  it('grants an agent the support work', () => {
    const support: Permission[] = [
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
    ];

    for (const permission of support) {
      expect(ROLE_PERMISSIONS.agent).toContain(permission);
    }
  });

  it('grants nothing outside the vocabulary', () => {
    for (const granted of Object.values(ROLE_PERMISSIONS)) {
      for (const permission of granted) {
        expect(PERMISSIONS).toContain(permission);
      }
    }
  });
});

describe('resolving a principal to permissions', () => {
  it('resolves a user through their role', () => {
    const permissions = permissionsFor({
      kind: 'user',
      tenantId: 'tenant',
      userId: 'user',
      role: 'agent',
    });

    expect(permissions.has('ticket:read')).toBe(true);
    expect(permissions.has('user:invite')).toBe(false);
  });

  /**
   * Fail-closed at the last layer too. A principal whose role the map does not
   * cover holds nothing — the guard then refuses it with a catalogued 403,
   * rather than the index throwing and the request becoming a 500 nobody
   * decided on.
   */
  it('resolves a role it does not know to no authority at all', () => {
    const permissions = permissionsFor({
      kind: 'user',
      tenantId: 'tenant',
      userId: 'user',
      role: 'retired-role' as UserRole,
    });

    expect(permissions.size).toBe(0);
  });

  it('resolves an admin to strictly more than an agent', () => {
    const admin = permissionsFor({
      kind: 'user',
      tenantId: 'tenant',
      userId: 'user',
      role: 'admin',
    });

    expect(admin.has('user:invite')).toBe(true);
  });
});
