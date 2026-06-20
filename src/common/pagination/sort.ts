import { AppException } from 'src/common/errors/app-exception';

export interface Sort {
  field: string;
  direction: 'asc' | 'desc';
}

/** Every list endpoint orders newest-first unless it says otherwise. */
export const DEFAULT_SORT: Sort = { field: 'createdAt', direction: 'desc' };

/**
 * Parses `?sort=field` / `?sort=-field` against a per-resource allowlist.
 *
 * Sortable fields are a closed set per resource, not an open query surface:
 * every allowed field needs a stable `(field, id)` keyset behind it, so adding
 * one is a deliberate act rather than a side effect of adding a column.
 */
export const parseSort = (
  raw: string | undefined,
  allowed: readonly string[],
  fallback: Sort = DEFAULT_SORT,
): Sort => {
  if (raw === undefined) return fallback;

  const direction = raw.startsWith('-') ? 'desc' : 'asc';
  const field = raw.startsWith('-') ? raw.slice(1) : raw;

  if (!allowed.includes(field)) {
    throw new AppException(
      'invalid_sort',
      `Cannot sort by '${field}'. Sortable fields: ${allowed.join(', ')}.`,
    );
  }

  return { field, direction };
};
