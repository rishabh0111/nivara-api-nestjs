import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { RequestPrincipal, tenantContextFor } from '../auth/request-principal';
import { permissionsFor } from '../authz/permissions';
import { AppException } from '../common/errors/app-exception';
import { ErrorCode } from '../common/errors/error-codes';
import {
  isForeignKeyViolation,
  isUniqueViolation,
} from '../common/errors/prisma-errors';
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
  TicketState,
} from '../generated/prisma/client';
import { RealtimeService } from '../realtime/realtime.service';
import { TenancyService, TenantClient } from '../tenancy/tenancy.service';
import { inChainWith } from './chain';
import { canTransition } from './state-machine';
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
  /**
   * The closed Ticket whose reply produced this one, when there is one.
   *
   * The *only* linkage input, and `rootTicketId` is conspicuously absent: the
   * root is derived by the database from this parent, so there is no call site
   * that could compute it wrongly. A caller names the fact it knows.
   */
  spawnedFromTicketId?: string;

  /**
   * Where this conversation is reachable outside Nivara, when it arrived from
   * somewhere that has such a place.
   *
   * Only an *origin* Ticket may name one, and only the adapter that read it off a
   * verified event ever does. A spawn inherits its parent's route from the
   * database — see `ticket_enforce_linkage()` — so the reply path never supplies
   * this and could not get it wrong if it tried: a value passed alongside
   * `spawnedFromTicketId` is overwritten by the trigger, exactly as a supplied
   * root is.
   */
  slackRoute?: { channelId: string; threadTs: string };
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
    private readonly realtime: RealtimeService,
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
    const ticket = await this.tenancy.withTenant(
      tenantContextFor(principal),
      (tx) => this.createIn(tx, principal, input),
    );

    // Announced after the commit, never inside it. An event emitted from within
    // the transaction would describe a Ticket that a later statement can still
    // roll back — and a socket has no way to retract what it has already
    // delivered, so a dashboard would be left holding a Ticket that does not
    // exist. The `*In` variants below therefore emit nothing at all: the caller
    // that owns the transaction is the only one that knows when it committed.
    await this.realtime.ticketCreated(ticket);

    return ticket;
  }

  /**
   * The same creation, inside a transaction the caller already owns.
   *
   * Exists because spawning a linked Ticket is not one write: the Ticket, its
   * audit row, and the Contact's reply as its first Message all have to commit
   * together. A spawned Ticket with no Message would be a thread born empty and
   * a first-response clock with nothing to measure from, which is exactly the
   * half-state the reply path exists to avoid.
   *
   * The `tx`-first shape is the one `AuditService.record` established, and for
   * the same reason: composition across services is a transaction question, and
   * a method that opened its own would silently break the atomicity its caller
   * is relying on.
   */
  async createIn(
    tx: TenantClient,
    principal: RequestPrincipal,
    input: CreateTicketInput,
  ): Promise<Ticket> {
    const ticket = await tx.ticket
      .create({
        data: {
          tenantId: principal.tenantId,
          subject: input.subject,
          contactId: input.contactId,
          source: input.source,
          // Named, never derived here. `rootTicketId` is absent from this
          // object on purpose: the trigger computes it from the parent, so the
          // denormalized column cannot disagree with the ancestry it
          // summarizes — in this port or in any other.
          spawnedFromTicketId: input.spawnedFromTicketId ?? null,
          // Null together or set together — the `ticket_slack_route_is_whole`
          // check refuses a half-route, because a channel with no thread would
          // deliver replies into a channel's top level rather than to the person
          // who asked.
          slackChannelId: input.slackRoute?.channelId ?? null,
          slackThreadTs: input.slackRoute?.threadTs ?? null,
        },
      })
      .catch((error: unknown) => {
        if (isForeignKeyViolation(error))
          throw AppException.notFound('Contact');

        rethrowTicketRefusal(error);
      });

    // `toValue` is the state the Ticket was born in, not its subject: this is
    // the control-plane record, and what it captures about a creation is where
    // the Ticket entered the state machine. The subject is domain data and
    // lives on the Ticket itself.
    //
    // No `metadata`, and linkage does not change that. `spawnedFromTicketId`
    // and `rootTicketId` are columns on the Ticket, readable there at any time
    // and immutable besides — copying them here would make the entry a partial
    // duplicate of a row it already points at. `metadata` is for facts with
    // nowhere else to live, like the scopes a minted token carried.
    await this.audit.record(tx, {
      action: AuditAction.ticket_created,
      targetKind: 'ticket',
      targetId: ticket.id,
      ticketId: ticket.id,
      toValue: ticket.state,
    });

    return ticket;
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
   * Moves a Ticket to another state.
   *
   * The two halves of the machine meet here, and the order is deliberate. The
   * authority question is asked first and locally, because it is the only half
   * this process knows the answer to — a credential is not something the
   * database can see. Legality is not asked at all: the `BEFORE UPDATE` trigger
   * owns the transition table, so this method attempts the move and translates
   * the refusal. Checking first would mean a second copy of the table that can
   * disagree with the one that decides, and would still not make the write
   * safe.
   *
   * The current state is read inside the transaction because `canTransition`
   * needs an origin, and the update is then a compare-and-set against exactly
   * the state that was read. Without that predicate, a concurrent transition
   * committing between the two statements would be authorized against a state
   * the Ticket has already left; with it, the loser gets a conflict instead.
   *
   * A move to the state a Ticket is already in is accepted and changes nothing.
   * The trigger does not see it — there is no transition to check or to record
   * — and answering "it is already open" with an error would make a retried
   * request fail where the first one succeeded.
   */
  async transition(
    principal: RequestPrincipal,
    id: string,
    to: TicketState,
  ): Promise<Ticket> {
    const ticket = await this.tenancy.withTenant(
      tenantContextFor(principal),
      (tx) => this.transitionIn(tx, principal, id, to),
    );

    await this.realtime.ticketUpdated(ticket);

    return ticket;
  }

  /**
   * The same move, inside a transaction the caller already owns.
   *
   * The reply path needs it: a Contact's reply to a `pending` or `resolved`
   * Ticket reopens it *and* posts the Message, and those are one act. Committing
   * the reopen without the Message would put a Ticket back in an agent's queue
   * with nothing new on it to read; committing the Message without the reopen
   * would leave the customer's reply sitting on a Ticket nobody is looking at.
   *
   * A Contact reaches this holding no permissions at all, and that is correct
   * rather than a hole: `canTransition` attaches authority only to `closed`, and
   * a reply never moves a Ticket there. The reopen is audited as the Contact's,
   * by the same trigger that permitted it, which is the honest attribution — the
   * customer is who caused it.
   */
  async transitionIn(
    tx: TenantClient,
    principal: RequestPrincipal,
    id: string,
    to: TicketState,
  ): Promise<Ticket> {
    const current = await tx.ticket.findUnique({ where: { id } });

    if (!current) throw AppException.notFound('Ticket');

    // The same refusal the guard gives, from `AppException.forbidden`: a
    // caller who learned that *this* transition specifically needs
    // `ticket:close` would have learned the shape of the tenant's authority
    // model from an endpoint the route-level grant already let them reach.
    if (!canTransition(current.state, to, permissionsFor(principal))) {
      throw AppException.forbidden();
    }

    const { count } = await tx.ticket
      .updateMany({
        where: { id, state: current.state },
        data: { state: to },
      })
      .catch(rethrowTicketRefusal);

    if (count === 0) {
      throw new AppException(
        'conflict',
        'The Ticket changed state while this request was in flight. Read it again and retry.',
      );
    }

    // No audit call. `ticket.transitioned` is written by the trigger that
    // permitted the move, in the same statement — recording it here as well
    // would double every entry, and recording it *only* here would leave the
    // guarantee resting on this call site rather than on the schema.

    return readBack(tx, id);
  }

  /**
   * Sets priority, which is not a state transition.
   *
   * Urgency and progress are orthogonal facts about a Ticket: any priority is
   * valid in any state, so this touches nothing the state machine owns and
   * needs none of its guard.
   *
   * With one exception, and it is enforced where it belongs rather than here: a
   * `closed` Ticket is a finished record, so the trigger refuses a priority
   * edit on one — as it refuses an assignment, for the same reason. That check
   * lives with the state machine because it is the one place the two axes
   * touch, and because a lone state test in this method would hold for this
   * port and no other.
   */
  async setPriority(
    principal: RequestPrincipal,
    id: string,
    priority: TicketPriority,
  ): Promise<Ticket> {
    const ticket = await this.update(principal, id, { priority });

    await this.realtime.ticketUpdated(ticket);

    return ticket;
  }

  /**
   * Sets or clears the assignee — `null` unassigns.
   *
   * At most one User, and nothing above it: no teams, no groups, no queues
   * owning a ticket. "Who is responsible for this" has exactly one answer or
   * none, and the schema says so rather than a convention around a join table.
   *
   * Refused on a `closed` Ticket, by the same trigger and for the same reason
   * priority is: handing finished work to someone is a claim about a queue
   * nobody is working.
   */
  async setAssignee(
    principal: RequestPrincipal,
    id: string,
    assigneeId: string | null,
  ): Promise<Ticket> {
    const ticket = await this.update(principal, id, { assigneeId }).catch(
      (error: unknown) => {
        // A User id from another tenant, or one that never existed. Both are
        // the same 404 for the same reason the Contact case is.
        if (isForeignKeyViolation(error)) throw AppException.notFound('User');

        throw error;
      },
    );

    // `ticketAssigned` and not `ticketUpdated`, though the payload is the same
    // snapshot. The dashboard reacts to a handover — a row moving into or out of
    // "mine" — where it merely re-renders an edit, and that difference is
    // carried by the event name rather than by a client diffing two snapshots to
    // work out which column moved.
    await this.realtime.ticketAssigned(ticket);

    return ticket;
  }

  /**
   * The whole conversation this Ticket belongs to, root to current.
   *
   * A chain rather than a tree, and readable as a narrative: the origin first,
   * then each Ticket a reply spawned, in the order they happened. A Ticket that
   * has never been closed-and-replied-to is a chain of one, which is the common
   * case and deliberately not a special one — a caller never has to ask whether
   * a conversation exists before reading it.
   *
   * One flat query, no recursion. `rootTicketId` is denormalized precisely so
   * this is `WHERE id = root OR rootTicketId = root` against an index, rather
   * than a `WITH RECURSIVE` that each of the three ports would have to
   * reimplement in its own dialect.
   *
   * The `?? id` is the null-origin convention: a Ticket with no root *is* the
   * root. Reading the anchor Ticket first is also what makes an invisible one a
   * 404 rather than an empty chain — an empty list would be a claim about a
   * Ticket the caller must not learn exists — and it happens in the same
   * transaction as the chain read, so the two cannot disagree about visibility.
   *
   * Unpaginated, in the list envelope. A chain grows only when a closed Ticket
   * is replied to, so it is bounded by how many times a conversation has been
   * finished and resumed — a handful, not a feed. Paginating it would hand a
   * client a fragment of a narrative and make "read the conversation" a loop.
   */
  async conversation(
    principal: RequestPrincipal,
    id: string,
  ): Promise<Ticket[]> {
    return this.tenancy.withTenant(tenantContextFor(principal), async (tx) => {
      const anchor = await tx.ticket.findUnique({ where: { id } });

      if (!anchor) throw AppException.notFound('Ticket');

      return tx.ticket.findMany({
        where: inChainWith(anchor),
        // Ascending, unlike every other list in this API. A queue is read
        // newest-first because the top of it is the work; a conversation is
        // read oldest-first because it is a story, and the standard default
        // would render it backwards.
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
    });
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
      const { count } = await tx.ticket
        .updateMany({ where: { id }, data })
        .catch(rethrowTicketRefusal);

      if (count === 0) throw AppException.notFound('Ticket');

      return readBack(tx, id);
    });
  }
}

/**
 * The row as written, inside the transaction that wrote it.
 *
 * Read back rather than reconstructed from the input, so the returned
 * representation carries whatever the database decided — `updatedAt`, and any
 * column a trigger touched — rather than what this process assumed. Inside the
 * transaction, so it cannot be a row a concurrent edit has already moved on
 * from.
 *
 * The 404 is unreachable in practice: the update that preceded it matched. It
 * is here because the alternative is a non-null assertion, and a wrong
 * assumption should surface as the same refusal every other invisible row gets
 * rather than as a 500.
 */
const readBack = async (tx: TenantClient, id: string): Promise<Ticket> => {
  const ticket = await tx.ticket.findUnique({ where: { id } });

  if (!ticket) throw AppException.notFound('Ticket');

  return ticket;
};

/**
 * The refusals the `ticket` triggers raise, and what a client is told about
 * each.
 *
 * Keyed by the custom SQLSTATE rather than by the message. The trigger's
 * wording is a diagnostic aimed at whoever is reading a log — it names the
 * Ticket, the states, and a SQL function to go look at — so branching on it
 * would make this API's error codes a function of that prose and would break
 * the day someone improves it. A SQLSTATE is the contract between the schema
 * and every port of it; the prose is not.
 *
 * The `code` is part of each entry rather than shared, because the table
 * outgrew the state machine when linkage arrived and the entries no longer
 * agree on one. Three of them are `conflict`: the request is well-formed and
 * would have been fine against a Ticket in another state, so what is wrong is
 * the state of the resource — which is what 409 means, and the remedy is to
 * re-read rather than to fix a field. `TK003` is the exception and is a 404,
 * because a parent this context cannot see is indistinguishable from one that
 * does not exist; saying anything else would turn the spawn path into a probe
 * for another Contact's Tickets.
 */
const TICKET_REFUSALS = {
  TK001: {
    code: 'conflict',
    message:
      'That is not a legal transition for this Ticket in its current state. Read it again to see where it is.',
  },
  TK002: {
    code: 'conflict',
    message:
      'A closed Ticket is a finished record: neither its priority nor its assignee can be changed.',
  },
  TK003: {
    code: 'not_found',
    message: 'No such Ticket is visible to this principal.',
  },
  TK004: {
    code: 'conflict',
    message:
      'A conversation\u2019s ancestry is set when a Ticket is created and cannot be rewritten.',
  },
  TK005: {
    code: 'conflict',
    message:
      'A Ticket is reachable where its conversation started. Re-pointing a live conversation at another thread is not an edit; it is a new Ticket.',
  },
} as const satisfies Record<string, { code: ErrorCode; message: string }>;

type TicketSqlstate = keyof typeof TICKET_REFUSALS;

/** Turns a trigger refusal into an API error, and rethrows anything else untouched. */
function rethrowTicketRefusal(error: unknown): never {
  const sqlstate = ticketSqlstate(error);

  if (sqlstate) {
    const { code, message } = TICKET_REFUSALS[sqlstate];

    throw new AppException(code, message);
  }

  throw error;
}

/**
 * The one-live-per-chain unique index, lost as a race.
 *
 * Two replies to the same closed Ticket arrived together, both read no live
 * Ticket, and both tried to spawn one — `ticket_one_live_per_chain` is what
 * stops the second becoming a duplicate the queue then carries forever.
 *
 * Deliberately *not* folded into `rethrowTicketRefusal`, though it was at first.
 * That function is reached by every write on this table, including priority and
 * assignee edits, and a uniqueness constraint added to `ticket` for some
 * unrelated reason would then have surfaced from a priority change as "another
 * reply was handled first" — a message about a feature the caller was not using.
 * A translation this specific belongs at the one call site whose failure it
 * actually describes.
 *
 * A 409 rather than a silent retry that appends to whichever Ticket won.
 * Retrying here would mean deciding, from inside a failed transaction, that the
 * caller meant something other than what they asked for; re-reading and replying
 * again is the same act, made by the client that knows whether it still wants
 * to.
 */
export function rethrowChainConflict(error: unknown): never {
  if (isUniqueViolation(error)) {
    throw new AppException(
      'conflict',
      'Another reply on this conversation was handled first. Read the conversation again and reply to its live Ticket.',
    );
  }

  throw error;
}

/**
 * The SQLSTATE behind a driver error, when it is one of ours.
 *
 * A trigger's `RAISE` is not a failure mode Prisma has a `P`-code for, so it
 * arrives as a driver adapter error carrying the raw Postgres fields on
 * `cause`. Read structurally rather than through `instanceof`, for the reason
 * the foreign-key check does: the generated client's error classes are not
 * guaranteed to be the ones a future client version constructs, and getting
 * this wrong turns a 409 into a 500.
 */
const ticketSqlstate = (error: unknown): TicketSqlstate | undefined => {
  if (typeof error !== 'object' || error === null) return undefined;

  const cause = (error as { cause?: unknown }).cause;

  if (typeof cause !== 'object' || cause === null) return undefined;

  const code = (cause as { code?: unknown }).code;

  return typeof code === 'string' && code in TICKET_REFUSALS
    ? (code as TicketSqlstate)
    : undefined;
};
