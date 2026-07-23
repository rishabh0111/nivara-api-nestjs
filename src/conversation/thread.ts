import { AppException } from '../common/errors/app-exception';
import { isForeignKeyViolation } from '../common/errors/prisma-errors';
import {
  KeysetPlan,
  keysetPlan,
  SortableFields,
  sortableFieldNames,
} from '../common/pagination/keyset';
import { parseSort, Sort } from '../common/pagination/sort';
import { TenantClient } from '../tenancy/tenancy.service';

/**
 * What the two threads have in common, and nothing else.
 *
 * `MessageService` and `NoteService` are separate services over separate
 * tables, which is the guarantee the Note boundary is built on: a Note cannot come back
 * from a customer-visible read because it does not live where that read looks.
 * What they genuinely share is the vocabulary of a thread — how it sorts, how
 * long an entry may be, and the two refusals a ticket-scoped read and write
 * each have to make.
 *
 * Nothing here names a table or opens a transaction. Each service does its own
 * `withTenant`, as `TicketService` and `AuditService` do, so what is shared is
 * only the part that could not pick the wrong table if it tried.
 */

/**
 * What a thread may be ordered by.
 *
 * One field, and it should stay one. A conversation has an order — the order it
 * happened in — and offering to sort it any other way would be offering to
 * render a discussion out of sequence.
 *
 * The API-wide default applies: newest first, so the first page of a long
 * thread is the part being worked on. A console rendering the thread top-down
 * asks for `?sort=createdAt`, which the same index serves.
 */
export const THREAD_SORTABLE: SortableFields = {
  createdAt: 'date',
};

/**
 * The longest a single entry may be.
 *
 * Generous rather than tuned: an agent pasting a stack trace or a log excerpt
 * into a Note is the normal case, not an abuse of the field. The limit exists
 * so that an unbounded body cannot be used to fill a tenant's storage from a
 * widget session, which is a different concern from what a person might
 * reasonably type.
 *
 * Shared by both DTOs because the two entities carry the same kind of content
 * and a divergence would be arbitrary — a Note that accepts less than a Message
 * would be a rule nobody could explain.
 */
export const MAX_BODY_LENGTH = 20_000;

export interface ListThreadInput {
  limit: number;
  cursor?: string;
  sort?: string;
}

/** The ordering, the seek predicate, and how many rows to ask for. */
export interface ThreadQuery {
  sort: Sort;
  plan: KeysetPlan;
  /** `limit + 1` — the extra row is the has-more probe. See `buildPage`. */
  take: number;
}

/**
 * Turns a thread's list query into the parts a `findMany` needs.
 *
 * Separated from the query itself so that validating the sort and decoding the
 * cursor happen once for both surfaces, leaving each service holding only the
 * part that names its own table.
 */
export const threadQuery = (input: ListThreadInput): ThreadQuery => {
  const sort = parseSort(input.sort, sortableFieldNames(THREAD_SORTABLE));

  return {
    sort,
    plan: keysetPlan(sort, input.cursor, THREAD_SORTABLE),
    take: input.limit + 1,
  };
};

/**
 * Refuses a Ticket this context cannot see, before its thread is read.
 *
 * Without this, reading an invisible Ticket's thread returns an empty page —
 * and an empty page is a worse answer than it looks: it says "this Ticket has
 * nothing on it", which is a claim about a Ticket the caller must not learn
 * exists. `AuditService.listForTicket` makes the same check for the same
 * reason.
 *
 * Takes `tx` rather than opening its own transaction, so the check and the page
 * that follows it cannot disagree about what is visible.
 */
export const assertTicketVisible = async (
  tx: TenantClient,
  ticketId: string,
): Promise<void> => {
  const ticket = await tx.ticket.findUnique({ where: { id: ticketId } });

  if (!ticket) throw AppException.notFound('Ticket');
};

/**
 * The refusal a thread *write* makes instead of that check.
 *
 * A write deliberately does not read the Ticket first. The composite foreign
 * key on `(tenant_id, ticket_id)` already refuses a Ticket outside this tenant
 * — row-level security is not what does that, since foreign keys are checked
 * with policies bypassed (ADR-0002) — so a read-then-write check would be
 * strictly worse: the same answer, plus a race the constraint does not have.
 *
 * The resulting 404 is identical to the one a nonexistent Ticket gets, so a
 * write endpoint cannot be used to probe for another tenant's Tickets.
 */
export function rethrowMissingTicket(error: unknown): never {
  if (isForeignKeyViolation(error)) throw AppException.notFound('Ticket');

  throw error;
}
