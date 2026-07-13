/**
 * The cache key grammar, and the third of this system's three
 * impossible-by-construction guarantees.
 *
 * The other two are row-level security below the application and tenant-prefixed
 * WebSocket rooms; this is the same idea applied to Redis. A cached read must
 * not be able to cross the boundary the database enforces, and the way that is
 * made true here is that the tenant segment is *written by this module* and sits
 * to the left of every segment a caller supplies. There is no argument on any
 * public cache method by which a caller names a tenant — see `cache.service.ts`,
 * where the tenant comes from the same server-determined `TenantContext` that
 * arms `withTenant()`.
 *
 * That is why this is a module of pure string functions rather than a private
 * method on the service: the guarantee is a property of the grammar, and it is
 * asserted here without a Redis anywhere near it.
 *
 * Key format: `cache:<tenantId>:<namespace>:<id>`.
 */

/**
 * The namespace every cached value lives under.
 *
 * One Redis client is shared with rate limiting, so the two features'
 * key spaces are kept apart by their prefixes alone — `cache:` here against
 * `rl:` in `rate-limit-keys.ts`. Both are constants for the same reason: the
 * proof that they do not collide should be two lines someone can read.
 */
export const CACHE_PREFIX = 'cache';

/**
 * A caller-supplied key segment that would make a key ambiguous.
 *
 * Always a programming error rather than bad user input — namespaces are
 * literals chosen at the call site and ids are internal identifiers, so neither
 * is reachable from a request body. It therefore does not extend
 * `AppException`: there is no error code for it and no caller who could fix it
 * by sending something else.
 */
export class InvalidCacheSegmentError extends Error {
  constructor(part: string, value: string) {
    super(
      `Cache ${part} ${JSON.stringify(value)} is not usable in a key: ` +
        'segments must be non-empty and free of ":" and glob metacharacters.',
    );
    this.name = 'InvalidCacheSegmentError';
  }
}

/**
 * What a segment may not contain, and why each is here.
 *
 * `:` is the delimiter, so a segment containing one would silently become two —
 * which is how two call sites end up addressing one key under different names.
 * The glob metacharacters matter to `delByPrefix` alone, which is the only
 * place a segment reaches Redis as a *pattern* rather than as a literal: a
 * namespace of `*` there would bust the tenant's whole subtree instead of one
 * namespace.
 *
 * Note what is *not* claimed. Neither hazard is a cross-tenant one — the tenant
 * segment is still further left, and no glob can move a match leftwards past a
 * literal prefix. This is about keys meaning one thing, not about isolation,
 * which the position of the tenant segment already settles.
 */
const FORBIDDEN = /[:*?[\]\\]/;

const checkSegment = (part: string, value: string): string => {
  if (!value || FORBIDDEN.test(value)) {
    throw new InvalidCacheSegmentError(part, value);
  }

  return value;
};

/**
 * The key one cached value lives at.
 *
 * `tenantId` is first because it is first in the key, and it is not a parameter
 * any caller of the cache passes — the service supplies it from the armed
 * context. Callers choose only the two segments to its right.
 */
export const cacheKey = (
  tenantId: string,
  namespace: string,
  id: string,
): string =>
  `${CACHE_PREFIX}:${tenantId}:${checkSegment('namespace', namespace)}:${checkSegment('id', id)}`;

/**
 * The prefix every key in one tenant's namespace shares.
 *
 * It keeps the trailing delimiter, which is the whole of its correctness: a
 * prefix of `cache:t1:origins` without it would also match `origins-legacy`, so
 * busting one namespace would quietly bust its neighbour.
 */
export const namespacePrefix = (tenantId: string, namespace: string): string =>
  `${CACHE_PREFIX}:${tenantId}:${checkSegment('namespace', namespace)}:`;
