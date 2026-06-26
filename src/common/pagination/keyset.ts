import { AppException } from 'src/common/errors/app-exception';
import { assertCursorMatchesSort, decodeCursor } from './cursor';
import { Sort } from './sort';

/**
 * How a sortable field's cursor value is read back.
 *
 * `date` exists because a cursor is JSON: a `DateTime` column's value makes
 * the round trip as an ISO string, and comparing a string against a timestamp
 * column is a type error Prisma raises at the worst possible moment — mid
 * traversal, on page two, in production. Declaring the shape here means the
 * conversion happens once, where the field is named.
 */
export type SortableFieldKind = 'date' | 'scalar';

/**
 * A resource's sortable fields and their kinds — the allowlist and the decode
 * table in one object, so a field cannot be sortable without also declaring
 * how its cursor value reads back.
 */
export type SortableFields = Record<string, SortableFieldKind>;

/** The allowlist half, for `parseSort`. */
export const sortableFieldNames = (fields: SortableFields): readonly string[] =>
  Object.keys(fields);

/**
 * The `orderBy` and `where` a keyset page needs.
 *
 * `where` is the seek predicate alone — the caller merges it with its own
 * filters. Kept separate rather than folded together because they answer
 * different questions ("which rows" versus "where was I"), and a helper that
 * owned both would have to know about every resource's filters.
 */
export interface KeysetPlan {
  orderBy: Record<string, 'asc' | 'desc'>[];
  /** Undefined on the first page: there is nowhere to seek from yet. */
  where: Record<string, unknown> | undefined;
}

/**
 * Turns a sort and an optional cursor into the ordering and seek predicate for
 * one page.
 *
 * Keyset rather than offset, because tickets and messages are exactly the
 * high-insert tables where `OFFSET` misbehaves: a row inserted ahead of the
 * reader shifts every subsequent offset by one, so page two silently repeats a
 * row page one already showed. A cursor names a *position in the ordering*
 * rather than a count of rows skipped, so concurrent inserts are invisible to
 * a traversal in progress.
 */
export const keysetPlan = (
  sort: Sort,
  cursor: string | undefined,
  fields: SortableFields,
): KeysetPlan => {
  const orderBy = orderByFor(sort);

  if (cursor === undefined) return { orderBy, where: undefined };

  const position = decodeCursor(cursor);
  assertCursorMatchesSort(position, sort);

  // The sort was checked against the allowlist by `parseSort`, and the cursor
  // was just checked against the sort — so this can only fail for a cursor
  // that no traversal of this resource issued. Refusing rather than trusting
  // it is what keeps a field name from a hand-forged cursor out of the query.
  const kind = fields[position.sort.field];

  if (kind === undefined) {
    throw new AppException(
      'invalid_cursor',
      'This cursor was not issued for this resource. Restart the traversal without a cursor.',
    );
  }

  return {
    orderBy,
    where: seekPast(sort, decodeValue(position.value, kind), position.id),
  };
};

const orderByFor = (sort: Sort): Record<string, 'asc' | 'desc'>[] =>
  // Sorting by `id` already is total; a second `id` term would be redundant
  // rather than wrong, but Prisma is happier without the duplicate key.
  sort.field === 'id'
    ? [{ id: sort.direction }]
    : [{ [sort.field]: sort.direction }, { id: sort.direction }];

const decodeValue = (
  value: string | number,
  kind: SortableFieldKind,
): unknown => (kind === 'date' ? new Date(value) : value);

/**
 * `(field, id) < (value, id)` — or `>` ascending — written out by hand.
 *
 * Postgres compares row values natively and the portable SQL for this is one
 * clean tuple comparison, but Prisma has no such operator, so the tuple is
 * expanded: strictly past the anchor's value, *or* level with it and past its
 * id. Both branches are load-bearing. Drop the first and the traversal never
 * leaves a run of tied rows; drop the second and it skips every row that ties
 * with the anchor.
 */
const seekPast = (
  sort: Sort,
  value: unknown,
  anchorId: string,
): Record<string, unknown> => {
  const operator = sort.direction === 'desc' ? 'lt' : 'gt';

  if (sort.field === 'id') return { id: { [operator]: anchorId } };

  return {
    OR: [
      { [sort.field]: { [operator]: value } },
      { [sort.field]: value, id: { [operator]: anchorId } },
    ],
  };
};
