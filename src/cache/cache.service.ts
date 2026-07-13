import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import { TenantContext, contextSettings } from '../tenancy/tenant-context';
import { cacheKey, namespacePrefix } from './cache-keys';

/**
 * How many keys one `SCAN` iteration asks Redis to look at.
 *
 * A hint rather than a page size — Redis may return more or fewer. It exists to
 * bound how long a single call can block the server, which is the reason
 * `delByPrefix` scans at all instead of issuing `KEYS`.
 */
const SCAN_COUNT = 250;

/** The two segments a caller supplies. The tenant is not among them. */
export interface CacheEntryKey {
  /** What kind of thing this is — a literal chosen at the call site. */
  readonly namespace: string;
  /** Which one, within the namespace and the tenant. */
  readonly id: string;
}

/**
 * The cache as one tenant can see it, which is the only way it can be seen.
 *
 * Every method takes a namespace and an id and nothing else; the tenant is
 * closed over from the context this handle was made with. That is what makes a
 * cross-tenant key *inexpressible* rather than merely discouraged — there is no
 * argument here to put another tenant's id into.
 */
export interface TenantCache {
  /**
   * The cached value, or the loader's, cached for next time.
   *
   * `ttlSeconds` is the backstop, not the invalidation strategy — see clause 3
   * on `CacheService`. No failure of Redis's can make this throw; a malformed
   * namespace of the caller's own still can. See clause 1 for why that line is
   * drawn where it is.
   */
  getOrLoad<T>(
    key: CacheEntryKey,
    ttlSeconds: number,
    loader: () => Promise<T>,
  ): Promise<T>;

  /** Bust one entry. Call this on the write path that invalidated it. */
  del(key: CacheEntryKey): Promise<void>;

  /** Bust a whole namespace within this tenant, and nothing beyond it. */
  delByPrefix(namespace: string): Promise<void>;
}

/**
 * The cache-aside seam — and, in v1, a seam with nothing behind it.
 *
 * **Nothing in this application caches anything.** That is a decision, not an
 * omission: no invalidation bug can exist while nothing is cached, and the
 * shape below is what lets a later ticket add one specific cached read without
 * re-architecting anything. `cache-usage.spec.ts` holds that line, and the
 * three clauses below are the rules for whoever crosses it first.
 *
 * ---
 *
 * ### 1. Always fail open — on everything the environment can do to you.
 *
 * A Redis miss, a Redis outage, an unparseable value, an unconfigured client —
 * all four run the loader against Postgres and return the correct answer. None
 * is surfaced to the caller; none fails a request. Postgres is the source of
 * truth, so losing Redis costs this system its cache, which is a degradation,
 * rather than its ability to answer, which would be an outage.
 *
 * This lives *inside* `getOrLoad` rather than in a rule call sites follow,
 * because the safe path should be the only path — there is no error for a
 * caller to catch and so no way to accidentally fail closed.
 *
 * What fail-open deliberately does **not** cover is a bug in the calling code,
 * and the distinction is worth being exact about because the two look alike
 * from inside the `try`. An `InvalidCacheSegmentError` from a malformed
 * namespace is raised *before* Redis is consulted and propagates out of every
 * method here. That is not an oversight and it is not a hole in clause 1: a
 * namespace is a literal chosen at the call site, so the error is deterministic
 * and fires on the very first call in development, never intermittently in
 * production. Catching it would convert a bug that announces itself into a
 * cache that silently never caches — the failure this seam would find hardest
 * to notice, since every read would still return the right answer, just slowly
 * and forever.
 *
 * It is the same posture `InvalidTenantContextError` takes one layer down, and
 * for the same reason: an outage is the environment's fault and is absorbed, a
 * malformed argument is ours and is surfaced.
 *
 * ### 2. Never cache security-hot state.
 *
 * ServiceToken validity and scopes, and per-principal permissions, are
 * **off-limits to this seam, full stop.** Instant revocation is non-negotiable,
 * and a TTL is precisely a revocation delay: a cached token stays valid for the
 * length of its TTL after it is revoked. If token-lookup latency ever bites
 * under real load, that earns a new revocation-aware ticket with bust-on-revoke
 * — not a TTL bolted onto this one.
 *
 * ### 3. Cacheable means read-heavy, stable, non-security configuration —
 * with bust-on-write *in addition to* a TTL.
 *
 * The TTL is the backstop for a bust that was missed or failed, not the
 * invalidation strategy. Anything cached must call `del`/`delByPrefix` from the
 * write path that changed it.
 *
 * Named safe but deliberately **not cached in v1**: the SLA target matrix, the
 * Origin allowlist, and the static role-to-permission map (the definition —
 * never a principal's live grants, which are clause 2). Hot Ticket reads are
 * parked: every Message, state change, SLA tick and assignment mutates a
 * Ticket, so the bust surface is large and the staleness risk real. Analytics
 * results are out entirely — those are live RLS-scoped aggregates with no
 * rollup table on purpose, and caching them would reintroduce exactly the
 * staleness that choice avoids.
 *
 * ---
 *
 * The Redis client is the one the rate limiter uses, injected from
 * `RedisModule` rather than opened again here. Two clients would mean two
 * connection pools and two chances to get the fail-open connection options
 * subtly differently; the key spaces stay apart by prefix alone — `cache:` here
 * against `rl:` there.
 */
@Injectable()
export class CacheService {
  private readonly logger = new Logger(CacheService.name);

  constructor(private readonly redis: RedisService) {}

  /**
   * A handle onto one tenant's subtree.
   *
   * Takes the whole `TenantContext` — the same server-determined object that
   * arms `withTenant()` — rather than a bare tenant id, and validates it with
   * the same function, so a context that could not arm a transaction cannot
   * mint a cache handle either. A caller holding one has, by construction, come
   * from a validated credential.
   */
  forTenant(context: TenantContext): TenantCache {
    const { tenantId } = contextSettings(context);

    return {
      getOrLoad: (key, ttlSeconds, loader) =>
        this.getOrLoad(tenantId, key, ttlSeconds, loader),
      del: (key) => this.del(tenantId, key),
      delByPrefix: (namespace) => this.delByPrefix(tenantId, namespace),
    };
  }

  private async getOrLoad<T>(
    tenantId: string,
    { namespace, id }: CacheEntryKey,
    ttlSeconds: number,
    loader: () => Promise<T>,
  ): Promise<T> {
    const key = cacheKey(tenantId, namespace, id);
    const cached = await this.read<T>(key);

    // A hit, including a cached `null`. ioredis reports a missing key as the
    // `null` reply and a stored null as the string `"null"`, so the two never
    // have to be told apart by guessing at the value.
    if (cached.hit) return cached.value;

    const loaded = await loader();

    await this.write(key, loaded, ttlSeconds);

    return loaded;
  }

  /** A hit and its value, or a miss — for any of the four reasons in clause 1. */
  private async read<T>(
    key: string,
  ): Promise<{ hit: true; value: T } | { hit: false }> {
    const client = this.redis.client;

    if (!client) return { hit: false };

    try {
      const raw = await client.get(key);

      if (raw === null) return { hit: false };

      return { hit: true, value: JSON.parse(raw) as T };
    } catch (error: unknown) {
      // Covers both an unreachable Redis and a value that will not parse. They
      // are one case here on purpose: both mean "no usable cached answer", and
      // both are answered by the loader. `debug` rather than `warn` because an
      // outage would otherwise produce one of these per request, burying the
      // connection error `RedisService` already logs at a level operators see.
      this.logger.debug(`Cache read failed for ${key}: ${describe(error)}`);

      return { hit: false };
    }
  }

  private async write(
    key: string,
    value: unknown,
    ttlSeconds: number,
  ): Promise<void> {
    const client = this.redis.client;

    if (!client) return;

    const serialised = JSON.stringify(value);

    // `undefined` has no JSON form, and there is nothing useful to store: any
    // placeholder would fail to parse on the way back out, which is a
    // guaranteed reload wearing a cache entry's clothes.
    if (serialised === undefined) return;

    try {
      await client.set(key, serialised, 'EX', ttlSeconds);
    } catch (error: unknown) {
      // The caller's answer is already correct — only the write-back failed.
      // Surfacing this would turn a healthy request into a 500 for the sake of
      // an optimisation that did not happen.
      this.logger.debug(`Cache write failed for ${key}: ${describe(error)}`);
    }
  }

  private async del(
    tenantId: string,
    { namespace, id }: CacheEntryKey,
  ): Promise<void> {
    const client = this.redis.client;

    if (!client) return;

    try {
      await client.unlink(cacheKey(tenantId, namespace, id));
    } catch (error: unknown) {
      this.logger.debug(`Cache bust failed: ${describe(error)}`);
    }
  }

  /**
   * Bust a namespace by scanning this tenant's subtree.
   *
   * `SCAN` rather than `KEYS`, which blocks the whole server for the length of
   * its sweep. The cursor is followed to the end because one `SCAN` call is not
   * a complete answer — stopping at the first page would leave a namespace
   * half-busted, which is worse than not busting it at all: the entries that
   * survived look fresh.
   *
   * The match pattern can only ever widen *within* the tenant — the tenant
   * segment is a literal to the left of anything a caller supplied, and no glob
   * matches leftwards past it. `cache-keys.ts` refuses glob metacharacters in a
   * namespace anyway, so the pattern's only wildcard is the one appended here.
   */
  private async delByPrefix(
    tenantId: string,
    namespace: string,
  ): Promise<void> {
    const client = this.redis.client;

    if (!client) return;

    const pattern = `${namespacePrefix(tenantId, namespace)}*`;

    try {
      let cursor = '0';

      do {
        const [next, keys] = await client.scan(
          cursor,
          'MATCH',
          pattern,
          'COUNT',
          SCAN_COUNT,
        );

        if (keys.length > 0) await client.unlink(...keys);

        cursor = next;
      } while (cursor !== '0');
    } catch (error: unknown) {
      // A partial bust is a real cost — the cache now disagrees with Postgres
      // for up to the entry's TTL, which is why a TTL is required alongside
      // every bust. It is still the right call: failing the write whose bust
      // this was would leave the database unchanged and the cache
      // authoritative, which is strictly worse.
      this.logger.debug(`Cache bust failed for ${pattern}: ${describe(error)}`);
    }
  }
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message || error.name : String(error);
