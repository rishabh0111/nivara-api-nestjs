import { AppException } from 'src/common/errors/app-exception';
import { Sort } from './sort';

const CURSOR_VERSION = 1;

/** The position a cursor names: one row, identified by its sort value and id. */
export interface CursorPosition {
  sort: Sort;
  /** The value of the active sort field on the anchor row. */
  value: string | number;
  /** The anchor row's id — the tiebreak that makes the keyset total. */
  id: string;
}

/**
 * The wire form. Single-letter keys keep the cursor short; the encoded form is
 * contractually opaque, so clients must never decode it and the shape here is
 * free to change behind a version bump.
 */
interface CursorPayload {
  v: number;
  f: string;
  d: 'asc' | 'desc';
  k: string | number;
  i: string;
}

const invalid = (): AppException =>
  new AppException(
    'invalid_cursor',
    'The pagination cursor is malformed. Restart the traversal without a cursor.',
  );

export const encodeCursor = (position: CursorPosition): string => {
  const payload: CursorPayload = {
    v: CURSOR_VERSION,
    f: position.sort.field,
    d: position.sort.direction,
    k: position.value,
    i: position.id,
  };

  return Buffer.from(JSON.stringify(payload)).toString('base64url');
};

export const decodeCursor = (cursor: string): CursorPosition => {
  let payload: unknown;

  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }

  if (!isCursorPayload(payload) || payload.v !== CURSOR_VERSION) {
    throw invalid();
  }

  return {
    sort: { field: payload.f, direction: payload.d },
    value: payload.k,
    id: payload.i,
  };
};

const isCursorPayload = (value: unknown): value is CursorPayload => {
  if (typeof value !== 'object' || value === null) return false;

  const candidate = value as Record<string, unknown>;

  return (
    typeof candidate.v === 'number' &&
    typeof candidate.f === 'string' &&
    (candidate.d === 'asc' || candidate.d === 'desc') &&
    (typeof candidate.k === 'string' || typeof candidate.k === 'number') &&
    typeof candidate.i === 'string'
  );
};

/**
 * The cursor carries the sort it was issued under. Changing `sort` mid-traversal
 * invalidates the cursor rather than silently mixing two orderings — the client
 * restarts from page one.
 */
export const assertCursorMatchesSort = (
  position: CursorPosition,
  sort: Sort,
): void => {
  if (
    position.sort.field !== sort.field ||
    position.sort.direction !== sort.direction
  ) {
    throw new AppException(
      'invalid_cursor',
      'This cursor was issued for a different sort. Restart the traversal without a cursor.',
    );
  }
};
