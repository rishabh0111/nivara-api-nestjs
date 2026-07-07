import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from './prisma.service';
import { TenantContext, contextSettings } from './tenant-context';

/**
 * A client that is already inside an armed tenant context.
 *
 * It is the same Prisma API minus the transaction controls — nesting a
 * transaction inside this one would open a second connection with no context
 * on it, which is precisely the mistake the type is shaped to prevent.
 */
export type TenantClient = Prisma.TransactionClient;

@Injectable()
export class TenancyService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Runs `work` inside one transaction with tenant and actor context armed.
   *
   * Three properties make this the only sanctioned way to reach the database,
   * and each of them is a bug that would otherwise be invisible:
   *
   * **The settings are transaction-local, never session-level.** Postgres keeps
   * a session-level `SET` on the physical connection after the transaction
   * commits. Under transaction-mode pooling — which is what Neon's pooler is —
   * that connection is then handed to the *next* client, tenant context and
   * all. `set_config(..., true)` is torn down at commit or rollback, before the
   * connection returns to the pool, so there is nothing left to leak.
   *
   * **They are armed as the transaction's first statement.** The policies read
   * the settings at query time, so anything issued before this line runs
   * against an unarmed context and, by the fail-closed predicate, sees nothing.
   *
   * **`work` receives `tx`, not the base client.** A Prisma interactive
   * transaction guarantees every query on `tx` runs on the one connection the
   * transaction owns. A query issued on the base client instead would take a
   * different connection out of the pool — one with no context on it — and
   * quietly return zero rows.
   *
   * The values are bound parameters rather than interpolated SQL. `SET LOCAL`
   * cannot take a bind parameter at all, which is the reason to prefer
   * `set_config()` over it.
   */
  async withTenant<T>(
    context: TenantContext,
    work: (tx: TenantClient) => Promise<T>,
  ): Promise<T> {
    // Validate before opening a transaction: a malformed context should cost
    // nothing, and should not surface as a Postgres error halfway through one.
    const { tenantId, actorKind, actorId } = contextSettings(context);

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT
          set_config('app.current_tenant', ${tenantId}, true),
          set_config('app.current_actor_kind', ${actorKind}, true),
          set_config('app.current_actor_id', ${actorId}, true)
      `;

      return work(tx);
    });
  }

  /**
   * Whether the database answers at all.
   *
   * A boolean rather than a throw, because the only caller is readiness and a
   * health check that has to catch to learn its answer is a boolean with extra
   * steps. It reads no row and arms no context on purpose: this asks whether
   * Postgres is reachable, and a query that could also fail on a policy would
   * conflate "the database is down" with "this context sees nothing" — which
   * are different incidents with different responses.
   */
  async ping(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Runs `work` inside one transaction with the *scheduler* context armed —
   * the one context in this application that is not scoped to a tenant.
   *
   * It exists because the drainer's central question is "which tenant's work is
   * due next", and a context has to be armed before that can be asked. Every
   * other caller learns its tenant from a credential and arms it; this one
   * learns its tenant *from the row it claims*, which is the wrong way round for
   * `withTenant()`.
   *
   * What it is not: a bypass. The setting it arms is named by exactly one
   * policy, on `job`, so a transaction opened here can read the queue and
   * nothing else — no ticket, no message, no contact, in any tenant. That is a
   * property of the migration rather than of this method, which is what makes it
   * worth relying on; `scheduler.int-spec.ts` asserts both halves, including a
   * scan of `pg_policies` to catch a second table growing the same clause.
   *
   * `app.current_tenant` is armed to the empty string rather than left unset.
   * The tenant policies map empty to NULL and a NULL predicate is not true, so
   * the fail-closed behaviour is identical — but arming it explicitly means this
   * transaction cannot inherit a value from anywhere, which is the property the
   * comment on `withTenant()` spends its length on.
   *
   * The actor is `system`, so anything this transaction happens to write is
   * attributed to the scheduler rather than to whoever enqueued the work.
   */
  async withScheduler<T>(work: (tx: TenantClient) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT
          set_config('app.current_tenant', '', true),
          set_config('app.current_actor_kind', 'system', true),
          set_config('app.current_actor_id', '', true),
          set_config('app.scheduler', 'on', true)
      `;

      return work(tx);
    });
  }
}
