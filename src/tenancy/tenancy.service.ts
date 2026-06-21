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
}
