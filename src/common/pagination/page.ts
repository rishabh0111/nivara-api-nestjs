import { encodeCursor } from './cursor';
import { Sort } from './sort';

/**
 * The list envelope. Single resources are returned bare; only collections wrap.
 *
 * There is no `total`, not even opt-in: a COUNT under RLS and concurrent
 * inserts is both expensive and a half-truth, and the agent console and AI
 * layer both want load-more rather than page numbers.
 */
export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

/**
 * Turns a fetched row set into a page.
 *
 * Callers query `limit + 1` rows. The extra row is the has-more probe: it never
 * reaches the client, it only proves there is another page. That is how the
 * cursor stays honest without a COUNT.
 */
export const buildPage = <T extends { id: string }>(
  rows: T[],
  limit: number,
  sort: Sort,
): Page<T> => {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const anchor = data[data.length - 1];

  if (!hasMore || anchor === undefined) {
    return { data, nextCursor: null };
  }

  return {
    data,
    nextCursor: encodeCursor({
      sort,
      value: sortValueOf(anchor, sort.field),
      id: anchor.id,
    }),
  };
};

const sortValueOf = (row: { id: string }, field: string): string | number => {
  const value = (row as Record<string, unknown>)[field];

  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' || typeof value === 'number') return value;

  // A sortable field that the query did not select is a programming error, not
  // a client error — surfacing it as a 500 is correct.
  throw new Error(
    `Cannot build a cursor: sort field '${field}' is missing or not a scalar on the anchor row.`,
  );
};
