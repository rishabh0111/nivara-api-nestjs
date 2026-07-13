import type Redis from 'ioredis';
import { RedisService } from '../redis/redis.service';
import { TenantContext } from '../tenancy/tenant-context';
import { CACHE_PREFIX, InvalidCacheSegmentError } from './cache-keys';
import { CacheService } from './cache.service';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

const contextFor = (tenantId: string): TenantContext => ({
  tenantId,
  actor: { kind: 'system' },
});

/**
 * A Redis that answers from a Map, and can be told to fail.
 *
 * Deliberately hand-rolled rather than a library double. The whole point of
 * these tests is what happens when Redis misbehaves, and the three ways it can
 * — absent, empty, throwing — are three lines here rather than a mocking
 * framework's idea of them.
 */
class FakeRedis {
  readonly store = new Map<string, string>();
  readonly ttls = new Map<string, number>();
  fail = false;

  // eslint-disable-next-line @typescript-eslint/require-await
  async get(key: string): Promise<string | null> {
    this.throwIfFailing();

    return this.store.get(key) ?? null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async set(
    key: string,
    value: string,
    _mode: string,
    ttl: number,
  ): Promise<'OK'> {
    this.throwIfFailing();
    this.store.set(key, value);
    this.ttls.set(key, ttl);

    return 'OK';
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async unlink(...keys: string[]): Promise<number> {
    this.throwIfFailing();

    return keys.filter((key) => this.store.delete(key)).length;
  }

  /**
   * One page containing everything, which is all these tests need — the
   * cursor loop itself is exercised by returning a non-zero cursor once in the
   * paging test below.
   */
  // eslint-disable-next-line @typescript-eslint/require-await
  async scan(
    _cursor: string,
    _match: string,
    pattern: string,
  ): Promise<[string, string[]]> {
    this.throwIfFailing();

    const prefix = pattern.replace(/\*$/, '');

    return [
      '0',
      [...this.store.keys()].filter((key) => key.startsWith(prefix)),
    ];
  }

  private throwIfFailing(): void {
    if (this.fail) throw new Error('ECONNREFUSED');
  }
}

/**
 * A `CacheService` over a given client, which may be absent.
 *
 * Returns only the service: the caller already holds the fake it passed in, and
 * handing it back would have made every assertion on the store reach through a
 * non-null assertion for a value the test itself just constructed.
 */
const cacheOver = (client: FakeRedis | null): CacheService =>
  new CacheService({
    client: client as unknown as Redis | null,
  } as RedisService);

/**
 * Fail-open, which is clause (a) of the seam's contract and the reason
 * `getOrLoad` exists at all rather than a thin `get`/`set` pair. Every one of
 * these asserts the same promise from a different failure: a cache problem
 * costs latency, never correctness.
 */
describe('getOrLoad fails open', () => {
  it('runs the loader when Redis is not configured', async () => {
    const cache = cacheOver(null);
    const loader = jest.fn().mockResolvedValue('from-postgres');

    await expect(
      cache
        .forTenant(contextFor(TENANT_A))
        .getOrLoad({ namespace: 'sla', id: 'matrix' }, 60, loader),
    ).resolves.toBe('from-postgres');

    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('runs the loader on a miss, and populates the cache with the TTL', async () => {
    const redis = new FakeRedis();
    const cache = cacheOver(redis);
    const loader = jest.fn().mockResolvedValue({ target: 30 });

    await expect(
      cache
        .forTenant(contextFor(TENANT_A))
        .getOrLoad({ namespace: 'sla', id: 'matrix' }, 60, loader),
    ).resolves.toEqual({ target: 30 });

    const key = `${CACHE_PREFIX}:${TENANT_A}:sla:matrix`;

    expect(loader).toHaveBeenCalledTimes(1);
    expect(redis.store.get(key)).toBe(JSON.stringify({ target: 30 }));
    expect(redis.ttls.get(key)).toBe(60);
  });

  /**
   * The outage case the ticket names explicitly. A throwing client must be
   * indistinguishable from a miss at the call site — same answer, one loader
   * call, no error surfaced.
   */
  it('runs the loader and returns a correct answer when Redis is down', async () => {
    const redis = new FakeRedis();
    const cache = cacheOver(redis);
    redis.fail = true;
    const loader = jest.fn().mockResolvedValue('from-postgres');

    await expect(
      cache
        .forTenant(contextFor(TENANT_A))
        .getOrLoad({ namespace: 'sla', id: 'matrix' }, 60, loader),
    ).resolves.toBe('from-postgres');

    expect(loader).toHaveBeenCalledTimes(1);
  });

  /**
   * The half of an outage that is easy to miss: the read succeeded, so the
   * loader has already produced the right answer, and only the *write back*
   * fails. Surfacing that would turn a healthy request into a 500 for no
   * reason — the caller's answer is already correct.
   */
  it('returns the loaded value even when populating the cache fails', async () => {
    const failOnSet = new FakeRedis();
    failOnSet.set = () => Promise.reject(new Error('ECONNRESET'));
    const cache = cacheOver(failOnSet);

    await expect(
      cache
        .forTenant(contextFor(TENANT_A))
        .getOrLoad({ namespace: 'sla', id: 'matrix' }, 60, () =>
          Promise.resolve('from-postgres'),
        ),
    ).resolves.toBe('from-postgres');
  });

  it('runs the loader when the cached value is not readable', async () => {
    const redis = new FakeRedis();
    const cache = cacheOver(redis);
    redis.store.set(`${CACHE_PREFIX}:${TENANT_A}:sla:matrix`, '{not json');
    const loader = jest.fn().mockResolvedValue('from-postgres');

    await expect(
      cache
        .forTenant(contextFor(TENANT_A))
        .getOrLoad({ namespace: 'sla', id: 'matrix' }, 60, loader),
    ).resolves.toBe('from-postgres');

    expect(loader).toHaveBeenCalledTimes(1);
  });

  /**
   * The boundary of clause 1, pinned so it cannot drift in either direction.
   *
   * A malformed namespace is the caller's bug, not the environment's, and it is
   * raised before Redis is consulted. Absorbing it into fail-open would trade a
   * bug that fires on the first call in development for a cache that silently
   * never caches — right answers, slowly, forever, and nothing to notice.
   */
  it('does not absorb a malformed namespace into fail-open', async () => {
    const cache = cacheOver(new FakeRedis());
    const loader = jest.fn();

    await expect(
      cache
        .forTenant(contextFor(TENANT_A))
        .getOrLoad({ namespace: 'sla:targets', id: 'matrix' }, 60, loader),
    ).rejects.toThrow(InvalidCacheSegmentError);

    expect(loader).not.toHaveBeenCalled();
  });

  /**
   * A loader's failure is *not* a cache failure. Fail-open covers Redis, and
   * swallowing a Postgres error here would turn a broken read into a silent
   * `undefined` — the wrong answer this seam exists to never give.
   */
  it('propagates the loader’s own failure rather than swallowing it', async () => {
    const cache = cacheOver(new FakeRedis());

    await expect(
      cache
        .forTenant(contextFor(TENANT_A))
        .getOrLoad({ namespace: 'sla', id: 'matrix' }, 60, () =>
          Promise.reject(new Error('postgres is down')),
        ),
    ).rejects.toThrow('postgres is down');
  });
});

describe('getOrLoad serves a hit', () => {
  it('returns the cached value without running the loader', async () => {
    const redis = new FakeRedis();
    const cache = cacheOver(redis);
    redis.store.set(
      `${CACHE_PREFIX}:${TENANT_A}:sla:matrix`,
      JSON.stringify({ target: 30 }),
    );
    const loader = jest.fn();

    await expect(
      cache
        .forTenant(contextFor(TENANT_A))
        .getOrLoad({ namespace: 'sla', id: 'matrix' }, 60, loader),
    ).resolves.toEqual({ target: 30 });

    expect(loader).not.toHaveBeenCalled();
  });

  /**
   * A cached `null` is a hit, not a miss. ioredis reports a missing key as the
   * `null` *reply* and a stored null as the string `"null"`, so the two are
   * distinguishable — and conflating them would make every null-valued entry a
   * permanent miss that reloads on every request.
   */
  it('treats a cached null as a hit', async () => {
    const redis = new FakeRedis();
    const cache = cacheOver(redis);
    redis.store.set(`${CACHE_PREFIX}:${TENANT_A}:sla:matrix`, 'null');
    const loader = jest.fn();

    await expect(
      cache
        .forTenant(contextFor(TENANT_A))
        .getOrLoad({ namespace: 'sla', id: 'matrix' }, 60, loader),
    ).resolves.toBeNull();

    expect(loader).not.toHaveBeenCalled();
  });

  /**
   * `undefined` has no JSON form, so there is nothing to store and nothing a
   * later read could tell apart from a miss. Writing `"undefined"` would be a
   * value that fails to parse on the way back out — a guaranteed reload
   * dressed up as a cache entry.
   */
  it('does not cache a value with no JSON form', async () => {
    const redis = new FakeRedis();
    const cache = cacheOver(redis);

    await expect(
      cache
        .forTenant(contextFor(TENANT_A))
        .getOrLoad({ namespace: 'sla', id: 'matrix' }, 60, () =>
          Promise.resolve(undefined),
        ),
    ).resolves.toBeUndefined();

    expect(redis.store.size).toBe(0);
  });
});

/**
 * The structural guarantee, asserted at the seam rather than only at the key
 * builder: what a caller *can reach* through this API.
 */
describe('the tenant prefix is the seam’s to write', () => {
  it('gives two tenants different keys for the same namespace and id', async () => {
    const redis = new FakeRedis();
    const cache = cacheOver(redis);
    const key = { namespace: 'origins', id: 'all' };

    await cache
      .forTenant(contextFor(TENANT_A))
      .getOrLoad(key, 60, () => Promise.resolve('a'));
    await cache
      .forTenant(contextFor(TENANT_B))
      .getOrLoad(key, 60, () => Promise.resolve('b'));

    expect([...redis.store.keys()].sort()).toEqual([
      `${CACHE_PREFIX}:${TENANT_A}:origins:all`,
      `${CACHE_PREFIX}:${TENANT_B}:origins:all`,
    ]);
  });

  /**
   * One tenant's cached value is invisible to the other — the same promise
   * row-level security makes below the application, made here by the key.
   */
  it('does not serve one tenant’s entry to another', async () => {
    const redis = new FakeRedis();
    const cache = cacheOver(redis);
    redis.store.set(
      `${CACHE_PREFIX}:${TENANT_A}:origins:all`,
      JSON.stringify('tenant-a-secret'),
    );

    await expect(
      cache
        .forTenant(contextFor(TENANT_B))
        .getOrLoad({ namespace: 'origins', id: 'all' }, 60, () =>
          Promise.resolve('tenant-b-value'),
        ),
    ).resolves.toBe('tenant-b-value');
  });

  /**
   * A malformed context is refused before any key is built, by the same
   * validation that arms a transaction. A cache handle for a tenant that
   * cannot be armed would be a handle onto keys no database read can match.
   */
  it('refuses a context that could not arm a transaction', () => {
    const cache = cacheOver(new FakeRedis());

    expect(() => cache.forTenant(contextFor('not-a-uuid'))).toThrow(
      /not a uuid/,
    );
  });
});

describe('busting', () => {
  it('deletes one entry by its tenant-prefixed key', async () => {
    const redis = new FakeRedis();
    const cache = cacheOver(redis);
    const key = `${CACHE_PREFIX}:${TENANT_A}:origins:all`;
    redis.store.set(key, '"x"');

    await cache
      .forTenant(contextFor(TENANT_A))
      .del({ namespace: 'origins', id: 'all' });

    expect(redis.store.has(key)).toBe(false);
  });

  it('deletes a whole namespace within the tenant, and nothing outside it', async () => {
    const redis = new FakeRedis();
    const cache = cacheOver(redis);
    const survivors = [
      `${CACHE_PREFIX}:${TENANT_B}:origins:all`,
      `${CACHE_PREFIX}:${TENANT_A}:sla:matrix`,
    ];
    for (const key of [
      `${CACHE_PREFIX}:${TENANT_A}:origins:all`,
      `${CACHE_PREFIX}:${TENANT_A}:origins:other`,
      ...survivors,
    ]) {
      redis.store.set(key, '"x"');
    }

    await cache.forTenant(contextFor(TENANT_A)).delByPrefix('origins');

    expect([...redis.store.keys()].sort()).toEqual(survivors.sort());
  });

  /**
   * A bust that fails is the one place fail-open is uncomfortable — the cache
   * now holds a value the database no longer agrees with. It is still the
   * right call: the TTL is the backstop that bounds the staleness, and failing
   * the *write* whose bust this was would leave the database unchanged and the
   * cache authoritative, which is strictly worse.
   */
  it('does not surface a Redis failure to the writer that triggered it', async () => {
    const redis = new FakeRedis();
    const cache = cacheOver(redis);
    redis.fail = true;
    const tenantCache = cache.forTenant(contextFor(TENANT_A));

    await expect(
      tenantCache.del({ namespace: 'origins', id: 'all' }),
    ).resolves.toBeUndefined();
    await expect(tenantCache.delByPrefix('origins')).resolves.toBeUndefined();
  });

  it('does nothing at all when Redis is not configured', async () => {
    const cache = cacheOver(null);
    const tenantCache = cache.forTenant(contextFor(TENANT_A));

    await expect(
      tenantCache.del({ namespace: 'origins', id: 'all' }),
    ).resolves.toBeUndefined();
    await expect(tenantCache.delByPrefix('origins')).resolves.toBeUndefined();
  });

  /**
   * `SCAN` returns a cursor, not a result set, and a single call is not a
   * complete answer — a namespace larger than one page would be half-busted by
   * an implementation that forgot to loop.
   */
  it('follows the scan cursor to the end', async () => {
    const redis = new FakeRedis();
    const firstPage = [`${CACHE_PREFIX}:${TENANT_A}:origins:one`];
    const secondPage = [`${CACHE_PREFIX}:${TENANT_A}:origins:two`];
    for (const key of [...firstPage, ...secondPage])
      redis.store.set(key, '"x"');

    const cursorsSeen: string[] = [];
    redis.scan = (cursor: string) => {
      cursorsSeen.push(cursor);

      return Promise.resolve<[string, string[]]>(
        cursor === '0' ? ['7', firstPage] : ['0', secondPage],
      );
    };

    const cache = cacheOver(redis);
    await cache.forTenant(contextFor(TENANT_A)).delByPrefix('origins');

    // The cursor Redis handed back is the one sent on the next call — a loop
    // that restarted from '0' each time would spin here rather than finish.
    expect(cursorsSeen).toEqual(['0', '7']);

    expect(redis.store.size).toBe(0);
  });
});
