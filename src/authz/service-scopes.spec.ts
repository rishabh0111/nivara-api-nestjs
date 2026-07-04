import { PERMISSIONS, Permission, ROLE_PERMISSIONS } from './permissions';
import {
  ASSIGNABLE_SCOPES,
  UNGRANTABLE_SCOPES,
  classifyScopes,
  grantedScopes,
} from './service-scopes';

/**
 * The claim ticket 12 rests on: there is one authority vocabulary, not two.
 *
 * These are assertions about data for the same reason the role-map tests are —
 * "no machine credential can ever hold `audit:read`" should be a property a
 * test states once, not a code review someone remembers to do.
 */
describe('the assignable scope list', () => {
  it('draws every scope from the staff permission vocabulary', () => {
    for (const scope of ASSIGNABLE_SCOPES) {
      expect(PERMISSIONS).toContain(scope);
    }
  });

  /**
   * Asserted over the whole catalog rather than a handful of interesting
   * permissions, so a permission added later is covered the day it is added:
   * it is either assignable or un-grantable, and never quietly neither.
   */
  it('partitions the catalog with nothing left over', () => {
    for (const permission of PERMISSIONS) {
      const assignable = ASSIGNABLE_SCOPES.includes(permission);
      const ungrantable = UNGRANTABLE_SCOPES.includes(permission);

      expect(assignable).not.toBe(ungrantable);
    }
  });

  it('withholds the destructive, configuration, user-management and audit grants', () => {
    const withheld: Permission[] = [
      'ticket:close',
      'ticket:delete',
      'user:invite',
      'user:deactivate',
      'sla:configure',
      'token:manage',
      'audit:read',
    ];

    for (const permission of withheld) {
      expect(UNGRANTABLE_SCOPES).toContain(permission);
      expect(ASSIGNABLE_SCOPES).not.toContain(permission);
    }
  });

  /**
   * A service token holding `token:manage` could mint itself a successor, so
   * revoking it would not end the machine's access. Stated on its own because
   * it is the one withheld grant whose absence is a containment property rather
   * than a caution.
   */
  it('cannot grant a token the authority to mint another token', () => {
    expect(ASSIGNABLE_SCOPES).not.toContain('token:manage');
  });

  /** The AI layer does support work, so it can hold no more than an agent. */
  it('assigns nothing an agent does not already hold', () => {
    for (const scope of ASSIGNABLE_SCOPES) {
      expect(ROLE_PERMISSIONS.agent).toContain(scope);
    }
  });

  /** Reply authority and note authority are separable, per the ticket. */
  it('offers reply and note authority independently', () => {
    expect(ASSIGNABLE_SCOPES).toContain('ticket:reply');
    expect(ASSIGNABLE_SCOPES).toContain('note:write');
  });
});

describe('classifying a requested scope list', () => {
  it('accepts a list drawn entirely from the assignable set', () => {
    expect(classifyScopes(['ticket:read', 'ticket:reply'])).toEqual({
      outcome: 'accept',
      scopes: ['ticket:read', 'ticket:reply'],
    });
  });

  it('accepts suggest-only: reply without note authority, and the reverse', () => {
    expect(classifyScopes(['ticket:read', 'ticket:reply']).outcome).toBe(
      'accept',
    );
    expect(classifyScopes(['note:read', 'note:write']).outcome).toBe('accept');
  });

  /**
   * The two refusals are told apart because they are different mistakes with
   * different fixes: a typo is corrected, whereas a real permission that no
   * machine may hold is a request to reconsider the design of the integration.
   * Neither discloses anything — the catalog is published in the OpenAPI
   * document, so both names are already public.
   */
  it('names an un-grantable permission as forbidden rather than unknown', () => {
    expect(classifyScopes(['ticket:read', 'audit:read'])).toEqual({
      outcome: 'forbidden',
      offending: ['audit:read'],
    });
  });

  it('names a value outside the vocabulary as unknown', () => {
    expect(classifyScopes(['ticket:read', 'ticket:obliterate'])).toEqual({
      outcome: 'unknown',
      offending: ['ticket:obliterate'],
    });
  });

  /** Reported before the forbidden check, so a typo is not called forbidden. */
  it('reports unknown values ahead of forbidden ones', () => {
    expect(classifyScopes(['audit:read', 'nonsense']).outcome).toBe('unknown');
  });

  it('refuses an empty grant, which would be a token that can do nothing', () => {
    expect(classifyScopes([]).outcome).toBe('empty');
  });

  it('collapses a repeated scope rather than granting it twice', () => {
    expect(classifyScopes(['ticket:read', 'ticket:read'])).toEqual({
      outcome: 'accept',
      scopes: ['ticket:read'],
    });
  });
});

/**
 * The read-side narrowing, and the reason it is not merely belt-and-braces:
 * `classifyScopes` guards the write path in *this* application, while the
 * stored column is plain text that a migration, a support script, or a port in
 * another language could write. This is where "no machine credential can ever
 * hold `audit:read`" stops depending on every writer having been careful.
 */
describe('narrowing the scopes stored on a row', () => {
  it('keeps the assignable scopes it finds', () => {
    expect(grantedScopes(['ticket:read', 'note:write'])).toEqual([
      'ticket:read',
      'note:write',
    ]);
  });

  it('drops an un-grantable scope somebody wrote to the row directly', () => {
    expect(grantedScopes(['ticket:read', 'audit:read'])).toEqual([
      'ticket:read',
    ]);
  });

  it('drops a value that is not a permission at all', () => {
    expect(grantedScopes(['ticket:read', 'ticket:retired'])).toEqual([
      'ticket:read',
    ]);
  });

  it('resolves a row with nothing usable to no authority', () => {
    expect(grantedScopes(['audit:read'])).toEqual([]);
  });
});
