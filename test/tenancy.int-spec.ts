import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppConfigModule } from 'src/config/app-config.module';
import { PrismaService } from 'src/tenancy/prisma.service';
import { InvalidTenantContextError } from 'src/tenancy/tenant-context';
import { TenancyModule } from 'src/tenancy/tenancy.module';
import { TenancyService } from 'src/tenancy/tenancy.service';
import { seededTenantIds } from './helpers/seeded-tenants';

/**
 * The isolation proof, against a real Postgres.
 *
 * These assertions cannot be made against a mock: what is under test is a
 * Postgres policy, the role it runs as, and the transaction it is armed in.
 * Everything here connects as `app_user` — the non-`BYPASSRLS` runtime role —
 * because as the owner every one of these tests would pass while proving
 * nothing.
 *
 * Requires `docker compose up -d postgres && npm run db:migrate` first; see
 * `npm run test:int`.
 */
describe('tenant isolation', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenancy: TenancyService;

  let meridian: string;
  let sortwood: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppConfigModule, TenancyModule],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();

    prisma = app.get(PrismaService);
    tenancy = app.get(TenancyService);

    // Read as the owner. `prisma` cannot see either row from out here — which
    // is the very property the tests below assert.
    ({ meridian, sortwood } = await seededTenantIds());

    expect(meridian).not.toEqual(sortwood);
  });

  afterAll(async () => {
    await app?.close();
  });

  /**
   * The actor for tests that are about isolation rather than provenance.
   *
   * `system` rather than a fabricated User or ServiceToken id: nothing here
   * needs a plausible actor, and an id pointing at no row would be a lie the
   * audit triggers later read as real provenance.
   */
  const asSystem = (tenantId: string) => ({
    tenantId,
    actor: { kind: 'system' as const },
  });

  describe('the runtime role', () => {
    it('cannot bypass row-level security', async () => {
      const [role] = await prisma.$queryRaw<
        { rolbypassrls: boolean; rolsuper: boolean }[]
      >`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`;

      expect(role).toEqual({ rolbypassrls: false, rolsuper: false });
    });
  });

  describe('outside any tenant context', () => {
    it('sees no tenants', async () => {
      await expect(prisma.tenant.findMany()).resolves.toEqual([]);
    });

    it('sees no users', async () => {
      await expect(prisma.user.findMany()).resolves.toEqual([]);
    });

    it('sees no contacts', async () => {
      await expect(prisma.contact.findMany()).resolves.toEqual([]);
    });

    it('cannot write either', async () => {
      await expect(
        prisma.contact.create({
          data: { tenantId: meridian, name: 'Smuggled in' },
        }),
      ).rejects.toThrow();
    });
  });

  describe('inside one tenant context', () => {
    it('sees only its own tenant row', async () => {
      const tenants = await tenancy.withTenant(asSystem(meridian), (tx) =>
        tx.tenant.findMany(),
      );

      expect(tenants.map((t) => t.id)).toEqual([meridian]);
    });

    it('sees its own users', async () => {
      const users = await tenancy.withTenant(asSystem(meridian), (tx) =>
        tx.user.findMany(),
      );

      expect(users.length).toBeGreaterThan(0);
      expect(users.every((user) => user.tenantId === meridian)).toBe(true);
    });

    it('cannot list another tenant’s users', async () => {
      const users = await tenancy.withTenant(asSystem(meridian), (tx) =>
        // Asking for them explicitly, which a forgotten scope in a service
        // would amount to. The policy answers, not the query.
        tx.user.findMany({ where: { tenantId: sortwood } }),
      );

      expect(users).toEqual([]);
    });

    it('cannot fetch another tenant’s contact by id', async () => {
      const theirs = await tenancy.withTenant(asSystem(sortwood), (tx) =>
        tx.contact.findFirstOrThrow(),
      );

      const found = await tenancy.withTenant(asSystem(meridian), (tx) =>
        tx.contact.findUnique({ where: { id: theirs.id } }),
      );

      // Indistinguishable from a row that does not exist — which is the point.
      expect(found).toBeNull();
    });

    it('cannot update another tenant’s row', async () => {
      const theirs = await tenancy.withTenant(asSystem(sortwood), (tx) =>
        tx.contact.findFirstOrThrow(),
      );

      const updated = await tenancy.withTenant(asSystem(meridian), (tx) =>
        tx.contact.updateMany({
          where: { id: theirs.id },
          data: { name: 'Renamed by the wrong tenant' },
        }),
      );

      expect(updated.count).toBe(0);

      const unchanged = await tenancy.withTenant(asSystem(sortwood), (tx) =>
        tx.contact.findUniqueOrThrow({ where: { id: theirs.id } }),
      );

      expect(unchanged.name).toEqual(theirs.name);
    });

    it('cannot plant a row under another tenant', async () => {
      await expect(
        tenancy.withTenant(asSystem(meridian), (tx) =>
          tx.contact.create({
            data: { tenantId: sortwood, name: 'Planted' },
          }),
        ),
      ).rejects.toThrow();
    });
  });

  describe('the transaction-local settings', () => {
    it('carry the tenant and actor the policies and audit triggers read', async () => {
      const actor = { kind: 'user' as const, id: meridian };

      const [settings] = await tenancy.withTenant(
        { tenantId: meridian, actor },
        (tx) => tx.$queryRaw<Record<string, string>[]>`
          SELECT
            current_setting('app.current_tenant', true)     AS tenant,
            current_setting('app.current_actor_kind', true) AS actor_kind,
            current_setting('app.current_actor_id', true)   AS actor_id
        `,
      );

      expect(settings).toEqual({
        tenant: meridian,
        actor_kind: 'user',
        actor_id: meridian,
      });
    });

    it('are gone once the transaction ends, so nothing leaks to the next caller', async () => {
      await tenancy.withTenant(asSystem(meridian), (tx) =>
        tx.tenant.findMany(),
      );

      // A fresh checkout from the same pool. If the settings had been armed
      // session-level, this would still see Meridian.
      await expect(prisma.tenant.findMany()).resolves.toEqual([]);
    });
  });

  describe('an unusable context', () => {
    it('raises when no actor is supplied', async () => {
      const noActor = { tenantId: meridian } as never;

      await expect(
        tenancy.withTenant(noActor, (tx) => tx.tenant.findMany()),
      ).rejects.toThrow(InvalidTenantContextError);
    });

    it('raises before opening a transaction', async () => {
      const spy = jest.spyOn(prisma, '$transaction');

      await expect(
        tenancy.withTenant({ tenantId: meridian } as never, (tx) =>
          tx.tenant.findMany(),
        ),
      ).rejects.toThrow(InvalidTenantContextError);

      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });
});
