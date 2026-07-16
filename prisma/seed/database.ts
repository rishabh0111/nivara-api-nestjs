import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../../src/generated/prisma/client';

/**
 * The seed's connection, and the two things it is allowed to do that nothing
 * else is.
 *
 * It runs as the owner over the direct endpoint. That is not a shortcut around
 * row-level security, it is the one job that cannot be done inside it: seeding
 * two tenants is by definition work no single tenant context could do, and
 * resetting the database is work no tenant context should be able to do at all.
 * The running application never holds this credential — see `prisma.config.ts`
 * for why the variable has a different name.
 */

export const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env['MIGRATE_DATABASE_URL'],
  }),
});

/** A client inside an armed transaction — the same shape `withTenant()` hands out. */
export type SeedClient = Prisma.TransactionClient;

/**
 * Who the database should believe is writing.
 *
 * The seed cares about this for a reason a fixture script usually does not.
 * Attribution here is not decoration: `author_kind` on a Message is what makes a
 * Ticket count as deflected, `actor_kind` on an audit row is what makes the
 * polymorphic-actor column demonstrable, and both are stamped by triggers from
 * the armed context rather than taken from the insert. So the only way to seed a
 * Ticket the AI answered is to arm `service` and write the reply — which is also
 * the only way the application can produce one.
 */
export interface SeedActor {
  /**
   * Three of the four `actor_kind` values, and `system` is missing on purpose:
   * it is what the server arms when it acts on its own account, and nothing in a
   * seeded demo is the server acting on its own account. Every row here was
   * written by somebody — a customer, an agent, or the AI layer — and widening
   * this to admit `system` would make an unattributed write expressible.
   */
  kind: 'user' | 'contact' | 'service';
  id?: string;
}

/**
 * Runs `work` in one transaction with tenant and actor context armed.
 *
 * Hand-rolled rather than imported from `TenancyService`, because that service
 * is a Nest provider with a connection of its own and the seed has no
 * application to boot — but the three settings, their transaction-local scope,
 * and the fact that they are armed as the first statement are all deliberately
 * identical. A seed that armed context differently from the runtime would be
 * exercising a path production never takes.
 *
 * The timeout is raised well above Prisma's five-second default: a single
 * seeded Ticket is a dozen statements, several of which fan out into triggers
 * that update the Ticket again, and a five-second ceiling turns a slow laptop
 * into a mysterious partial seed.
 */
export const armed = <T>(
  tenantId: string,
  actor: SeedActor,
  work: (tx: SeedClient) => Promise<T>,
): Promise<T> =>
  prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`
        SELECT
          set_config('app.current_tenant', ${tenantId}, true),
          set_config('app.current_actor_kind', ${actor.kind}, true),
          set_config('app.current_actor_id', ${actor.id ?? ''}, true)
      `;

      return work(tx);
    },
    { timeout: 60_000, maxWait: 30_000 },
  );

/**
 * Empties every seeded table, so a second run lands on the same state as the
 * first.
 *
 * Truncate-then-insert rather than upsert, and the difference is the point: an
 * upserting seed converges the rows it knows about and leaves everything a
 * developer created in between, so "reset to a known state" would be false
 * exactly when somebody needed it. Anchored ids make the trade cheap — the rows
 * documentation quotes come back with the same ids, which is the only continuity
 * that was ever worth preserving.
 *
 * One statement, cascading from `tenant`. Every seeded table references it
 * transitively, so naming them individually would be a list to keep in step with
 * the schema, and the day it fell behind the seed would silently stop resetting
 * one table.
 *
 * ### The audit log
 *
 * `audit_log` refuses TRUNCATE from a trigger, deliberately and including for
 * the owner — the migration explains why, and the reason is sound: the log is
 * one statement away from gone otherwise. The guard is suspended here for the
 * width of one statement and restored immediately, which is the narrowest way to
 * state the exception.
 *
 * It is a real exception and worth being uncomfortable about. What makes it
 * defensible is that it needs the credential that only exists during the release
 * step, and that the same credential could re-grant itself the privilege and
 * drop the trigger outright — so this is not a hole in the guarantee, it is the
 * guarantee's stated boundary being used on purpose. The running application
 * holds no credential that can reach it.
 */
export const reset = async (): Promise<void> => {
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "audit_log" DISABLE TRIGGER "no_truncate"`,
  );

  try {
    await prisma.$executeRawUnsafe(`TRUNCATE TABLE "tenant" CASCADE`);
  } finally {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "audit_log" ENABLE TRIGGER "no_truncate"`,
    );
  }
};
