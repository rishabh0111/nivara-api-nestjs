import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { RequestPrincipal, tenantContextFor } from '../auth/request-principal';
import { AppException } from '../common/errors/app-exception';
import {
  keysetPlan,
  SortableFields,
  sortableFieldNames,
} from '../common/pagination/keyset';
import { buildPage, Page } from '../common/pagination/page';
import { parseSort } from '../common/pagination/sort';
import {
  AuditAction,
  Ticket,
  TicketPriority,
  TicketSource,
} from '../generated/prisma/client';
import { TenancyService } from '../tenancy/tenancy.service';
import { TicketFilters, ticketWhere } from './ticket-filters';

/**
 * What a Ticket may be ordered by.
 *
 * Kept small on purpose: every field here needs a stable `(field, id)` keyset
 * behind it and an index to serve it, so this list grows by decision rather
 * than by someone noticing a column exists.
 */
export const TICKET_SORTABLE: SortableFields = {
  createdAt: 'date',
  updatedAt: 'date',
};

export interface CreateTicketInput {
  subject: string;
  contactId: string;
  source: TicketSource;
}

export interface ListTicketsInput extends TicketFilters {
  limit: number;
  cursor?: string;
  sort?: string;
}

/**
 * Running a queue: creating tickets, reading them, and the two edits that are
 * not state transitions.
 *
 * Every method here opens with `withTenant`, and none of them writes a
 * `tenantId` into a `where` clause. That is the whole tenancy story: the
 * policy is the predicate, so a forgotten filter in this file cannot leak
 * another tenant's rows — it returns nothing instead.
 */
@Injectable()
export class TicketService {
  constructor(
    private readonly tenancy: TenancyService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Opens a Ticket on a Contact's behalf.
   *
   * State and priority are absent from the input and that is deliberate: a
   * Ticket is born `open` and `normal`, from the column defaults, so new work
   * is unambiguous and triage is an explicit act rather than something the
   * creator asserted. A caller who wants `urgent` says so in a second call
   * that is separately permissioned and separately audited.
   *
   * The requester is not checked for existence first. The composite foreign key
   * on `(tenant_id, contact_id)` already refuses a Contact outside this tenant
   * — and note that row-level security is *not* what does that, since foreign
   * keys are checked with policies bypassed (ADR-0002). A read-then-write check
   * would therefore be strictly worse: a race the constraint does not have.
   *
   * Translating the violation into a 404 keeps the answer identical to the one
   * a nonexistent Contact gets, so this endpoint cannot be used to probe for
   * the existence of another tenant's Contacts.
   *
   * The audit row is written inside the same transaction as the Ticket, so the
   * two commit together or not at all. A Ticket that exists with no record of
   * its creation, and a record of a creation that rolled back, are both states
   * this makes unreachable rather than unlikely.
   */
  async create(
    principal: RequestPrincipal,
    input: CreateTicketInput,
  ): Promise<Ticket> {
    return this.tenancy.withTenant(tenantContextFor(principal), async (tx) => {
      const ticket = await tx.ticket
        .create({
          data: {
            tenantId: principal.tenantId,
            subject: input.subject,
            contactId: input.contactId,
            source: input.source,
          },
        })
        .catch((error: unknown) => {
          if (isForeignKeyViolation(error))
            throw AppException.notFound('Contact');

          throw error;
        });

      // `toValue` is the state the Ticket was born in, not its subject: this is
      // the control-plane record, and what it captures about a creation is where
      // the Ticket entered the state machine. The subject is domain data and
      // lives on the Ticket itself.
      //
      // No `metadata`. Source and priority are columns on the Ticket, readable
      // there at any time — copying them here would make the entry a partial,
      // silently-stale duplicate of a row it already points at. `metadata` is
      // for facts with nowhere else to live, like the scopes a minted token
      // carried.
      await this.audit.record(tx, {
        action: AuditAction.ticket_created,
        targetKind: 'ticket',
        targetId: ticket.id,
        ticketId: ticket.id,
        toValue: ticket.state,
      });

      return ticket;
    });
  }

  /** One Ticket, or the 404 that another tenant's Ticket is indistinguishable from. */
  async findOne(principal: RequestPrincipal, id: string): Promise<Ticket> {
    const ticket = await this.tenancy.withTenant(
      tenantContextFor(principal),
      (tx) => tx.ticket.findUnique({ where: { id } }),
    );

    if (!ticket) throw AppException.notFound('Ticket');

    return ticket;
  }

  /**
   * A page of Tickets under the allowlisted filters and sort.
   *
   * `limit + 1` rows are fetched: the extra one never reaches the client, it
   * only proves there is another page, which is how the cursor stays honest
   * without a `COUNT` that RLS would make expensive and concurrency would make
   * a half-truth.
   */
  async list(
    principal: RequestPrincipal,
    input: ListTicketsInput,
  ): Promise<Page<Ticket>> {
    const { limit, cursor, sort: rawSort, ...filters } = input;

    const sort = parseSort(rawSort, sortableFieldNames(TICKET_SORTABLE));
    const plan = keysetPlan(sort, cursor, TICKET_SORTABLE);

    const rows = await this.tenancy.withTenant(
      tenantContextFor(principal),
      (tx) =>
        tx.ticket.findMany({
          // The filters and the seek predicate are separate concerns that both
          // have to hold, so they are ANDed rather than merged key-by-key — a
          // spread would let a filter on `createdAt` silently overwrite the
          // cursor's bound on the same column and restart the traversal.
          where: { AND: [ticketWhere(filters), plan.where ?? {}] },
          orderBy: plan.orderBy,
          take: limit + 1,
        }),
    );

    return buildPage(rows, limit, sort);
  }

  /**
   * Sets priority, which is not a state transition.
   *
   * Urgency and progress are orthogonal facts about a Ticket: any priority is
   * valid in any state, so this touches nothing the state machine owns and
   * needs none of its guard.
   *
   * With one exception, which is deliberately not implemented here: a `closed`
   * Ticket is locked, and priority is meant to be immutable on it. That is the
   * one place the two axes touch, so it belongs with the state machine in
   * ticket 07 rather than as a lone state check in a service that otherwise
   * knows nothing about states. Unreachable until then — nothing can move a
   * Ticket to `closed` yet.
   */
  async setPriority(
    principal: RequestPrincipal,
    id: string,
    priority: TicketPriority,
  ): Promise<Ticket> {
    return this.update(principal, id, { priority });
  }

  /**
   * Sets or clears the assignee — `null` unassigns.
   *
   * At most one User, and nothing above it: no teams, no groups, no queues
   * owning a ticket. "Who is responsible for this" has exactly one answer or
   * none, and the schema says so rather than a convention around a join table.
   */
  async setAssignee(
    principal: RequestPrincipal,
    id: string,
    assigneeId: string | null,
  ): Promise<Ticket> {
    return this.update(principal, id, { assigneeId }).catch(
      (error: unknown) => {
        // A User id from another tenant, or one that never existed. Both are
        // the same 404 for the same reason the Contact case is.
        if (isForeignKeyViolation(error)) throw AppException.notFound('User');

        throw error;
      },
    );
  }

  /**
   * The shared edit path.
   *
   * `updateMany` rather than `update`, because `update` on an invisible row
   * raises Prisma's `P2025` — a distinguishable failure mode for a row that
   * this principal must not be able to distinguish from a nonexistent one.
   * A count of zero is the same answer either way, and it becomes the same
   * 404.
   */
  private async update(
    principal: RequestPrincipal,
    id: string,
    data: { priority?: TicketPriority; assigneeId?: string | null },
  ): Promise<Ticket> {
    return this.tenancy.withTenant(tenantContextFor(principal), async (tx) => {
      const { count } = await tx.ticket.updateMany({ where: { id }, data });

      if (count === 0) throw AppException.notFound('Ticket');

      // Read back inside the same transaction, so the returned representation
      // is the row as written rather than one a concurrent edit may have moved
      // on from.
      const ticket = await tx.ticket.findUnique({ where: { id } });

      if (!ticket) throw AppException.notFound('Ticket');

      return ticket;
    });
  }
}

/**
 * Whether a write named a row that, from inside this tenant context, does not
 * exist.
 *
 * `P2003` is Prisma's foreign-key constraint failure. Matched structurally
 * rather than with `instanceof`, for the reason `InvitationService` gives: the
 * generated client's error classes are not necessarily the ones a future
 * client version constructs, and getting this wrong turns a 404 into a 500.
 */
const isForeignKeyViolation = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === 'P2003';
