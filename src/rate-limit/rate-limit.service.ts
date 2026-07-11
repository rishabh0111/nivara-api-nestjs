import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis/redis.service';
import {
  RateLimit,
  RateLimitDecision,
  decide,
  windowBucket,
} from './fixed-window';

/**
 * The counter, and the only thing in this feature that talks to Redis.
 *
 * One method, and it is the whole of the runtime surface: a key builder decides
 * *what* is being counted, `decide()` decides what the count means, and this
 * decides nothing at all beyond how to increment durably and what to do when
 * that is impossible. Splitting it that way is why the boundary arithmetic and
 * the key isolation are unit-tested without a Redis anywhere near them.
 *
 * Every failure path converges on `null`, which `decide()` reads as "allowed".
 * That convergence is deliberate: there is no way to call this and accidentally
 * fail *closed*, because there is no error to catch at the call site and no
 * exception it can throw. Fail-open is a property of the type rather than of
 * each caller remembering a try/catch.
 */
@Injectable()
export class RateLimitService {
  private readonly logger = new Logger(RateLimitService.name);

  constructor(private readonly redis: RedisService) {}

  /**
   * Charge one request against a key, and say whether it is over the line.
   *
   * `key` is built by the caller from server-determined inputs — see
   * `rate-limit-keys.ts`, which is the only sanctioned way to build one.
   *
   * `INCR` then `EXPIRE`, pipelined into one `MULTI` so they reach Redis
   * together. `INCR` on a missing key creates it at 1, so there is no
   * initialise-then-increment race: two concurrent first requests get 1 and 2
   * rather than both getting 1. The check is on the *post*-increment value for
   * the same reason — a read-then-compare-then-write would let two callers both
   * observe the last allowed count and both proceed.
   *
   * The TTL is re-set on every hit rather than only on creation. It is a window
   * longer than strictly needed, which costs a little memory on a key nobody is
   * hitting any more and buys independence from the `EXPIRE … NX` option's
   * Redis-version floor. The counter itself is unaffected: the bucket is in the
   * key, so a new window is a new key regardless of what the old one's TTL says.
   */
  async check(
    key: (bucket: number) => string,
    limit: RateLimit,
    nowMs: number = Date.now(),
  ): Promise<RateLimitDecision> {
    const count = await this.hit(
      key(windowBucket(nowMs, limit.windowSeconds)),
      limit.windowSeconds,
    );

    return decide(count, limit, nowMs);
  }

  /** The count after this hit, or `null` if Redis could not answer. */
  private async hit(
    key: string,
    windowSeconds: number,
  ): Promise<number | null> {
    const client = this.redis.client;

    // Redis is not configured. The commonest case on a first run, and not worth
    // a log line per request — `RedisService` says so once at boot.
    if (!client) return null;

    try {
      const replies = await client
        .multi()
        .incr(key)
        .expire(key, windowSeconds)
        .exec();

      const count = replies?.[0]?.[1];

      return typeof count === 'number' ? count : null;
    } catch (error: unknown) {
      // `debug` rather than `warn`: an unreachable Redis produces one of these
      // per request, and `RedisService`'s connection listener already reports
      // the outage itself at a level an operator will see. Logging the
      // consequence at the same level as the cause would bury the cause.
      this.logger.debug(
        `Rate-limit counter unavailable, allowing request: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      return null;
    }
  }
}
