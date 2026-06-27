import { Injectable } from '@nestjs/common';
import { RequestPrincipal, tenantContextFor } from '../auth/request-principal';
import { AppException } from '../common/errors/app-exception';
import {
  keysetPlan,
  SortableFields,
  sortableFieldNames,
} from '../common/pagination/keyset';
import { buildPage, Page } from '../common/pagination/page';
import { parseSort } from '../common/pagination/sort';
import { AuditLog, Prisma } from '../generated/prisma/client';
import { TenancyService, TenantClient } from '../tenancy/tenancy.service';
import { AuditEntry } from './audit-entry';

/**
 * What a timeline may be ordered by.
 *
 * One field, and it is unlikely to grow. A log is read in the order things
 * happened; sorting it any other way is asking a question the list envelope is
 * the wrong shape to answer.
 */
export const AUDIT_SORTABLE: SortableFields = {
  createdAt: 'date',
};

export interface ListAuditInput {
  limit: number;
  cursor?: string;
  sort?: string;
}

/**
 * Writing and reading the append-only record.
 *
 * The service is thin on purpose. Every property that makes the log worth
 * trusting — that history cannot be rewritten, that a row cannot exist without
 * an attributed actor, that the actor is the one who armed the transaction
 * rather than the one the code claims — is enforced in Postgres, not here. That
 * is what lets the Spring and FastAPI ports inherit the guarantees instead of
 * reimplementing them, and it is why there is no validation in `record()` for a
 * reviewer to check the completeness of.
 */
@Injectable()
export class AuditService {
  constructor(private readonly tenancy: TenancyService) {}

  /**
   * Appends one row, inside the caller's transaction.
   *
   * Taking `tx` rather than a principal is the whole design of this method. The
   * audit row and the change it describes commit together or not at all, so
   * there is no window in which the system has changed and the log does not say
   * so — and no way for a rolled-back attempt to leave a row claiming it
   * happened. A method that opened its own transaction would quietly break both.
   *
   * Nothing is returned. A caller that wanted the row back would be treating
   * the log as a store to read from rather than a record to write to, and the
   * only sanctioned read is the timeline below.
   */
  async record(tx: TenantClient, entry: AuditEntry): Promise<void> {
    await tx.auditLog.create({
      data: {
        action: entry.action,
        targetKind: entry.targetKind,
        targetId: entry.targetId,
        ticketId: entry.ticketId ?? null,
        fromValue: entry.fromValue ?? null,
        toValue: entry.toValue ?? null,
        // `DbNull` rather than `undefined`: on a nullable Json column those are
        // different instructions to Prisma, and only one of them writes SQL
        // NULL.
        metadata: (entry.metadata as Prisma.InputJsonValue) ?? Prisma.DbNull,
      },
    });
  }

  /**
   * One Ticket's timeline, newest first.
   *
   * The Ticket is read first so that a Ticket which does not exist — or which
   * belongs to another tenant, and is therefore invisible to this context — is
   * a 404 rather than an empty page. An empty page would be a worse answer than
   * it looks: it says "this Ticket has no history", which is a claim about a
   * Ticket the caller must not learn exists.
   *
   * Both reads share one transaction, so the existence check and the timeline
   * cannot disagree about what is visible.
   */
  async listForTicket(
    principal: RequestPrincipal,
    ticketId: string,
    input: ListAuditInput,
  ): Promise<Page<AuditLog>> {
    const { limit, cursor, sort: rawSort } = input;

    const sort = parseSort(rawSort, sortableFieldNames(AUDIT_SORTABLE));
    const plan = keysetPlan(sort, cursor, AUDIT_SORTABLE);

    const rows = await this.tenancy.withTenant(
      tenantContextFor(principal),
      async (tx) => {
        const ticket = await tx.ticket.findUnique({ where: { id: ticketId } });

        if (!ticket) throw AppException.notFound('Ticket');

        return tx.auditLog.findMany({
          where: { AND: [{ ticketId }, plan.where ?? {}] },
          orderBy: plan.orderBy,
          take: limit + 1,
        });
      },
    );

    return buildPage(rows, limit, sort);
  }
}
