import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfigService } from '../config/app-config.service';

/**
 * How long a single command may take before it is abandoned.
 *
 * A rate limiter sits in front of every request, so a slow Redis must not
 * become slow requests. Abandoning the command and falling through to
 * fail-open costs the ceiling for that request; waiting would cost the latency
 * of every request in the process.
 */
const COMMAND_TIMEOUT_MS = 200;

const CONNECT_TIMEOUT_MS = 1_000;

/**
 * The one Redis connection in the process.
 *
 * Deliberately a single shared client rather than one per consumer. Rate
 * limiting owns it today and the cache seam will sit beside it under its own
 * key prefix; two clients would mean two connection pools, two sets of
 * reconnection behaviour, and two places for the fail-open configuration below
 * to be got subtly differently.
 *
 * **Redis is optional.** `REDIS_URL` is absent on the credential-free first run
 * and in most tests, and that is a supported configuration rather than a
 * degraded one: `client` is then `null` and every consumer takes its fail-open
 * path. Nothing here throws at boot, because a missing cache must not be able
 * to stop the API starting.
 *
 * The three connection options are the whole of what makes fail-open real, and
 * each of them overrides an ioredis default that would defeat it:
 *
 *   * `enableOfflineQueue: false` — the default buffers commands while the
 *     connection is down and resolves them if it comes back. That turns a Redis
 *     outage into requests that hang rather than requests that proceed, which
 *     is precisely the failure mode fail-open exists to avoid. Off, a command
 *     issued while disconnected rejects at once and the caller falls through.
 *   * `maxRetriesPerRequest: 1` — bounds the same problem for a connection that
 *     is up but flapping.
 *   * `commandTimeout` — bounds it for a connection that is up and slow, which
 *     the other two do not catch at all.
 *
 * `lazyConnect` keeps the connection attempt out of module construction, so a
 * misconfigured or unreachable URL surfaces as a logged error and a null-ish
 * client rather than as a boot failure.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);

  /**
   * The live client, or `null` when Redis is not configured.
   *
   * Consumers branch on this rather than on a `configured` flag, so "Redis is
   * dormant" and "I have nothing to call" are one check instead of two that can
   * disagree. A non-null client may still be disconnected — the options above
   * make that reject promptly, which is the consumer's other fail-open path.
   */
  readonly client: Redis | null;

  constructor(config: AppConfigService) {
    const url = config.redisUrl;

    if (!url) {
      this.client = null;
      this.logger.log(
        'Redis is not configured — cache and rate limiting are dormant',
      );
      return;
    }

    this.client = new Redis(url, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      commandTimeout: COMMAND_TIMEOUT_MS,
      connectTimeout: CONNECT_TIMEOUT_MS,
    });

    // ioredis emits `error` on every failed reconnection attempt, and an
    // `error` event with no listener is an unhandled exception that takes the
    // process down under Node's default policy. Logging it is what turns a
    // Redis outage into a degraded ceiling rather than a crash loop — which is
    // the same fail-open promise, made at the transport level.
    this.client.on('error', (error: Error) => {
      this.logger.warn(`Redis unavailable: ${describe(error)}`);
    });

    this.client.connect().catch(() => {
      // Already reported by the listener above. Swallowed here because a failed
      // first connect must not reject into bootstrap, and ioredis keeps
      // retrying in the background regardless.
    });
  }

  onModuleDestroy(): void {
    // `disconnect()` rather than `quit()`, and synchronous as a result. `quit()`
    // waits for a round trip, and the case where shutdown most needs to make
    // progress is exactly the case where Redis is not answering.
    this.client?.disconnect();
  }
}

/**
 * A connection error, in terms an operator can act on.
 *
 * ioredis raises a refused connection with an empty `message` and the useful
 * part — `ECONNREFUSED`, `ENOTFOUND` — only on `code`, so logging the message
 * alone produces `Redis unavailable:` and nothing else. That is exactly the
 * line someone reads while trying to work out whether Redis is down or
 * misaddressed, and the two have different fixes.
 */
const describe = (error: Error): string => {
  const code = (error as NodeJS.ErrnoException).code;

  return error.message || code || error.name || 'unknown error';
};
