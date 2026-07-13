import { RATE_LIMIT_PREFIX } from '../rate-limit/rate-limit-keys';
import {
  CACHE_PREFIX,
  InvalidCacheSegmentError,
  cacheKey,
  namespacePrefix,
} from './cache-keys';

/**
 * The two features share one Redis connection, so their key spaces are kept
 * apart by prefix and nothing else. Asserted rather than assumed, because the
 * cost of a collision is not a crash: `delByPrefix` would quietly reset a
 * rate-limit counter, or a cached value would be read as one. This is the only
 * place both constants are in scope, which is why it is also the only reason
 * `RATE_LIMIT_PREFIX` is exported.
 */
describe('the two key spaces sharing one Redis', () => {
  it('do not collide, in either direction', () => {
    expect(CACHE_PREFIX).not.toBe(RATE_LIMIT_PREFIX);
    expect(`${CACHE_PREFIX}:`.startsWith(`${RATE_LIMIT_PREFIX}:`)).toBe(false);
    expect(`${RATE_LIMIT_PREFIX}:`.startsWith(`${CACHE_PREFIX}:`)).toBe(false);
  });
});

/**
 * The key grammar, which is where the cross-tenant guarantee actually lives.
 *
 * Every assertion below is about one property: the tenant segment is written by
 * this module and sits to the left of everything a caller supplies. A caller
 * can choose a strange namespace or a strange id and still cannot reach a key
 * belonging to another tenant, because nothing it supplies is interpreted
 * before the prefix.
 */
describe('a cache key', () => {
  it('carries the tenant, the namespace and the id, under the cache prefix', () => {
    expect(cacheKey('t1', 'sla-targets', 'urgent')).toBe(
      `${CACHE_PREFIX}:t1:sla-targets:urgent`,
    );
  });

  it('separates the same namespace and id across two tenants', () => {
    expect(cacheKey('t1', 'origins', 'all')).not.toBe(
      cacheKey('t2', 'origins', 'all'),
    );
  });

  it('separates two namespaces within one tenant', () => {
    expect(cacheKey('t1', 'origins', 'all')).not.toBe(
      cacheKey('t1', 'roles', 'all'),
    );
  });

  /**
   * The escape attempt, asserted rather than assumed. A namespace bearing a
   * colon is how a caller would try to write its own tenant segment, and it is
   * refused at the boundary — not because the resulting key would leak (the
   * real tenant is still further left) but because two callers could then
   * address one key by different names.
   */
  it('refuses a namespace that tries to write its own segments', () => {
    expect(() => cacheKey('t1', 'origins:t2:origins', 'all')).toThrow(
      InvalidCacheSegmentError,
    );
  });

  it('refuses an id that tries to write its own segments', () => {
    expect(() => cacheKey('t1', 'origins', 'a:b')).toThrow(
      InvalidCacheSegmentError,
    );
  });

  /**
   * Glob metacharacters are refused for `delByPrefix`'s sake — it is the one
   * operation that hands a caller-influenced string to Redis as a *pattern*,
   * and a namespace of `*` would widen it to the whole of the tenant's subtree
   * rather than one namespace within it. Still not cross-tenant, but not what
   * the caller asked for either.
   */
  it.each(['*', '?', '[a]', ']', '\\'])(
    'refuses the glob metacharacter in %p',
    (namespace) => {
      expect(() => cacheKey('t1', namespace, 'all')).toThrow(
        InvalidCacheSegmentError,
      );
    },
  );

  it('refuses an empty namespace', () => {
    expect(() => cacheKey('t1', '', 'all')).toThrow(InvalidCacheSegmentError);
  });

  it('refuses an empty id', () => {
    expect(() => cacheKey('t1', 'origins', '')).toThrow(
      InvalidCacheSegmentError,
    );
  });
});

/**
 * The prefix a namespace-wide bust matches on.
 *
 * Its one hazard is the trailing delimiter: without it, busting `origins` would
 * also take `origins-legacy` with it.
 */
describe('a namespace prefix', () => {
  it('ends at the delimiter, so it cannot match a longer namespace', () => {
    expect(namespacePrefix('t1', 'origins')).toBe(
      `${CACHE_PREFIX}:t1:origins:`,
    );
  });

  it('is a prefix of every key in its namespace', () => {
    expect(
      cacheKey('t1', 'origins', 'all').startsWith(
        namespacePrefix('t1', 'origins'),
      ),
    ).toBe(true);
  });

  it('is not a prefix of the same namespace in another tenant', () => {
    expect(
      cacheKey('t2', 'origins', 'all').startsWith(
        namespacePrefix('t1', 'origins'),
      ),
    ).toBe(false);
  });

  it('refuses the same segments `cacheKey` refuses', () => {
    expect(() => namespacePrefix('t1', 'origins:t2')).toThrow(
      InvalidCacheSegmentError,
    );
  });
});
