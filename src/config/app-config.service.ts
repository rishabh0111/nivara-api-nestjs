import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RateLimit } from '../rate-limit/fixed-window';
import { Env } from './env.schema';

/**
 * Typed access to validated configuration.
 *
 * Nothing else in the application reads `process.env`. Going through here means
 * a key that does not exist is a compile error rather than a runtime
 * `undefined`, and it gives feature gates one place to live.
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  get<K extends keyof Env>(key: K): Env[K] {
    return this.config.get(key, { infer: true });
  }

  get nodeEnv(): Env['NODE_ENV'] {
    return this.get('NODE_ENV');
  }

  get port(): number {
    return this.get('PORT');
  }

  /**
   * The runtime connection string — always the non-`BYPASSRLS` `app_user`.
   *
   * There is deliberately no accessor for `MIGRATE_DATABASE_URL`. The owner
   * credential belongs to the Prisma CLI, and giving the application a typed
   * way to read it would be the first step toward something using it.
   */
  get databaseUrl(): string {
    return this.get('DATABASE_URL');
  }

  /**
   * The shared Redis connection string. `undefined` when Redis is dormant.
   *
   * Its absence is a supported configuration rather than a fault: rate limiting
   * and the cache seam both fail open, so a process with no Redis serves every
   * request correctly and simply enforces no ceilings.
   */
  get redisUrl(): string | undefined {
    return this.get('REDIS_URL');
  }

  /**
   * The three ceilings, read as one object.
   *
   * Together rather than as three accessors, because they are configured,
   * reasoned about and tuned as a set — and because a call site that wanted one
   * of them in isolation would be a per-route limit, which the uniform-ceiling
   * design explicitly deferred.
   *
   * Windowed at sixty seconds here rather than in the limiter, so the pairing of
   * a ceiling with the span it is measured over happens once. A limiter handed a
   * bare number would have to know that the number meant "per minute".
   */
  get rateLimits(): {
    authenticated: RateLimit;
    slackPerIp: RateLimit;
    slackGlobal: RateLimit;
  } {
    const overAMinute = (limit: number): RateLimit => ({
      limit,
      windowSeconds: 60,
    });

    return {
      authenticated: overAMinute(
        this.get('RATE_LIMIT_AUTHENTICATED_PER_MINUTE'),
      ),
      slackPerIp: overAMinute(this.get('RATE_LIMIT_SLACK_IP_PER_MINUTE')),
      slackGlobal: overAMinute(this.get('RATE_LIMIT_SLACK_GLOBAL_PER_MINUTE')),
    };
  }

  /** Signs and verifies staff access tokens. Symmetric — HS256, one process. */
  get jwtSecret(): string {
    return this.get('JWT_SECRET');
  }

  /**
   * Signs and verifies widget session tokens.
   *
   * Deliberately not `jwtSecret`. A widget session and a staff access token are
   * signed by different keys so that a token minted for one surface fails to
   * verify on the other at the signature, before any claim is inspected — see
   * the schema comment for why that is worth a second key.
   */
  get widgetSessionSecret(): string {
    return this.get('WIDGET_SESSION_SECRET');
  }

  /**
   * Identifies this application to Google. `undefined` when Google is dormant.
   *
   * Public by OAuth's own reckoning — it travels in every authorization URL — but
   * it is not decorative: it is the `aud` an ID token has to carry, which is the
   * check that stops a token minted for another application being replayed here.
   */
  get googleClientId(): string | undefined {
    return this.get('GOOGLE_CLIENT_ID');
  }

  /**
   * Authenticates this application to Google's token endpoint. `undefined` when
   * Google is dormant.
   *
   * Load-bearing beyond authentication: it is what makes the token endpoint's
   * answer trustworthy on the strength of the channel alone, which is why the
   * ID token that comes back needs no signature check. See `google-id-token.ts`.
   */
  get googleClientSecret(): string | undefined {
    return this.get('GOOGLE_CLIENT_SECRET');
  }

  /**
   * Verifies inbound Slack requests. `undefined` when Slack is dormant.
   *
   * One secret for the whole app rather than one per tenant, because there is one
   * distributed Slack app: the signature proves the request came from Slack, and
   * *which tenant it belongs to* is a separate question answered afterwards by
   * the installation record. Conflating the two would mean knowing the tenant
   * before the request was trusted, which is the wrong way round.
   */
  get slackSigningSecret(): string | undefined {
    return this.get('SLACK_SIGNING_SECRET');
  }

  /**
   * Authenticates this system's postings back into Slack. `undefined` when Slack
   * is dormant.
   *
   * In configuration rather than on the installation row, and that is a decision
   * with a reason rather than a convenience: resolving a workspace happens before
   * any tenant is known, so it runs under a cross-tenant lookup context — and
   * granting that over a table holding credentials is a much larger thing than
   * granting it over a routing table. The migration makes the argument in full.
   *
   * The seam it leaves open is per-workspace tokens, which is what the OAuth
   * install flow produces. It lands as a second table read under the tenant the
   * installation resolved, and this accessor becomes the fallback.
   */
  get slackBotToken(): string | undefined {
    return this.get('SLACK_BOT_TOKEN');
  }

  /**
   * Deployments of the front end, and the only origins granted credentialed
   * CORS. Empty means no browser front end is configured against this
   * instance — a supported state, and not an invitation to reflect anything.
   */
  get webOrigins(): readonly string[] {
    return this.get('WEB_ORIGINS');
  }

  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  }

  get swaggerEnabled(): boolean {
    return this.get('SWAGGER_ENABLED');
  }

  /**
   * Whether this process runs the scheduler's ticks.
   *
   * Read in two places that must never disagree — the ticker, deciding whether
   * to start, and readiness, deciding whether a missing heartbeat is an outage
   * or the expected state. If readiness inferred it from whether any tick had
   * registered instead, a ticker that threw during bootstrap would report as a
   * healthy dormant scheduler, which is the one failure worth catching.
   */
  get runScheduler(): boolean {
    return this.get('RUN_SCHEDULER');
  }

  /**
   * Which optional integrations are live.
   *
   * A dormant integration is the normal state, not a degraded one: the demo
   * path runs with both of these false. Code behind a gate checks here rather
   * than testing a secret for undefined at the call site.
   */
  get features(): { google: boolean; slack: boolean } {
    return {
      google: this.get('GOOGLE_CLIENT_ID') !== undefined,
      slack: this.get('SLACK_SIGNING_SECRET') !== undefined,
    };
  }
}
