import {
  Actor,
  InvalidTenantContextError,
  TenantContext,
  contextSettings,
} from './tenant-context';

const TENANT = '0198f3a0-0000-7000-8000-000000000001';
const ACTOR = '0198f3a0-0000-7000-8000-0000000000aa';

const context = (overrides: Partial<TenantContext> = {}): TenantContext => ({
  tenantId: TENANT,
  actor: { kind: 'user', id: ACTOR },
  ...overrides,
});

describe('contextSettings', () => {
  it('maps a user actor onto the three transaction-local settings', () => {
    expect(contextSettings(context())).toEqual({
      tenantId: TENANT,
      actorKind: 'user',
      actorId: ACTOR,
    });
  });

  it.each<Actor>([
    { kind: 'user', id: ACTOR },
    { kind: 'contact', id: ACTOR },
    { kind: 'service', id: ACTOR },
  ])('carries the id of a $kind actor', (actor) => {
    expect(contextSettings(context({ actor }))).toMatchObject({
      actorKind: actor.kind,
      actorId: ACTOR,
    });
  });

  it('gives the system actor an empty id rather than inventing one', () => {
    expect(contextSettings(context({ actor: { kind: 'system' } }))).toEqual({
      tenantId: TENANT,
      actorKind: 'system',
      actorId: '',
    });
  });

  describe('rejects a context it cannot arm', () => {
    it('when no actor is supplied', () => {
      const withoutActor = { tenantId: TENANT } as unknown as TenantContext;

      expect(() => contextSettings(withoutActor)).toThrow(
        InvalidTenantContextError,
      );
    });

    it('when the actor kind is not one the audit trail knows', () => {
      const unknownKind = context({
        actor: { kind: 'robot', id: ACTOR } as unknown as Actor,
      });

      expect(() => contextSettings(unknownKind)).toThrow(
        InvalidTenantContextError,
      );
    });

    it('when a non-system actor carries no id', () => {
      const anonymous = context({
        actor: { kind: 'user' } as unknown as Actor,
      });

      expect(() => contextSettings(anonymous)).toThrow(
        InvalidTenantContextError,
      );
    });

    it('when the tenant id is not a uuid', () => {
      expect(() => contextSettings(context({ tenantId: 'meridian' }))).toThrow(
        InvalidTenantContextError,
      );
    });

    it('when the tenant id is absent', () => {
      const untenanted = {
        actor: { kind: 'system' },
      } as unknown as TenantContext;

      expect(() => contextSettings(untenanted)).toThrow(
        InvalidTenantContextError,
      );
    });
  });
});
