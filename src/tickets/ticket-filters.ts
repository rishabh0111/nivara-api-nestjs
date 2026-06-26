import { AppException } from '../common/errors/app-exception';
import {
  Prisma,
  TicketPriority,
  TicketSource,
  TicketState,
} from '../generated/prisma/client';

/**
 * The raw filter half of `GET /tickets`, exactly as it arrives on the query
 * string. Every value is a string here because every query parameter is; this
 * module is where they stop being strings.
 */
export interface TicketFilters {
  state?: string;
  priority?: string;
  source?: string;
  assigneeId?: string;
  contactId?: string;
  createdAfter?: string;
  createdBefore?: string;
}

/** The literal that asks for untriaged work. */
export const UNASSIGNED = 'none';

const STATES = Object.values(TicketState);
const PRIORITIES = Object.values(TicketPriority);
const SOURCES = Object.values(TicketSource);

/**
 * Turns the query string's filters into a Prisma `where`.
 *
 * A closed set of fields with fixed operators, not a query language. An open
 * filter DSL (RSQL, OData) would leak the schema into the wire contract, give
 * callers a way to write predicates nobody costed, and have to be re-parsed
 * identically in every port of this API. Adding a filter here is meant to be a
 * deliberate act with a diff to review.
 *
 * Values are validated rather than trusted: an unknown one is refused with
 * `invalid_filter`, never dropped. Silently ignoring it would answer a
 * different question from the one asked, and the response gives the caller no
 * way to notice.
 *
 * Tenancy appears nowhere in what this returns, and that is the point — the
 * row-level security policy is the tenant predicate, so there is no
 * `tenantId` here for a future edit to forget.
 */
export const ticketWhere = (
  filters: TicketFilters,
): Prisma.TicketWhereInput => {
  const where: Prisma.TicketWhereInput = {};

  if (filters.state !== undefined) {
    where.state = { in: enumSet(filters.state, STATES, 'state') };
  }

  if (filters.priority !== undefined) {
    where.priority = { in: enumSet(filters.priority, PRIORITIES, 'priority') };
  }

  if (filters.source !== undefined) {
    where.source = { in: enumSet(filters.source, SOURCES, 'source') };
  }

  if (filters.assigneeId !== undefined) {
    // `none` rather than an empty value: "unassigned" and "not filtering on
    // assignee" are different questions, and `?assigneeId=` cannot tell them
    // apart — an empty string is what a client sends when its variable is
    // unset, which is precisely when it means the second.
    where.assigneeId =
      filters.assigneeId === UNASSIGNED
        ? null
        : uuid(filters.assigneeId, 'assigneeId');
  }

  if (filters.contactId !== undefined) {
    where.contactId = uuid(filters.contactId, 'contactId');
  }

  const createdAt = {
    ...(filters.createdAfter !== undefined && {
      gte: timestamp(filters.createdAfter, 'createdAfter'),
    }),
    ...(filters.createdBefore !== undefined && {
      lte: timestamp(filters.createdBefore, 'createdBefore'),
    }),
  };

  if (Object.keys(createdAt).length > 0) where.createdAt = createdAt;

  return where;
};

/**
 * A comma-separated set of enum values, all of which must be members.
 *
 * One bad value refuses the whole set rather than being dropped from it: a
 * caller who asked for `open,escalated` and silently received only the open
 * ones has a bug they cannot see from the response.
 */
const enumSet = <T extends string>(
  raw: string,
  allowed: readonly T[],
  parameter: string,
): T[] => {
  const values = raw.split(',').map((value) => value.trim());

  for (const value of values) {
    if (!(allowed as readonly string[]).includes(value)) {
      throw new AppException(
        'invalid_filter',
        `'${value}' is not a valid ${parameter}. Allowed values: ${allowed.join(', ')}.`,
      );
    }
  }

  return values as T[];
};

/**
 * Every id column in this schema is `uuid`.
 *
 * Refused here rather than handed to Prisma for the same reason a malformed
 * timestamp is: Postgres does not quietly fail to match a malformed uuid, it
 * raises a type error, and that reaches the client as a 500. Nothing is
 * disclosed by saying so — a value that is not a uuid cannot be any row's id,
 * so this refusal is about shape and never about existence.
 */
const uuid = (raw: string, parameter: string): string => {
  if (!UUID_PATTERN.test(raw)) {
    throw new AppException(
      'invalid_filter',
      `'${raw}' is not a valid ${parameter}. Supply a uuid.`,
    );
  }

  return raw;
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An ISO-8601 instant. Refused here rather than handed to Prisma, where an
 * `Invalid Date` becomes a 500 — the client's typo reported as a server fault.
 */
const timestamp = (raw: string, parameter: string): Date => {
  const value = new Date(raw);

  if (Number.isNaN(value.getTime())) {
    throw new AppException(
      'invalid_filter',
      `'${raw}' is not a valid ${parameter}. Supply an ISO-8601 timestamp.`,
    );
  }

  return value;
};
