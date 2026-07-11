import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { AppConfigService } from '../config/app-config.service';
import { clientIp } from './client-ip';
import { slackGlobalKey, slackIpKey } from './rate-limit-keys';
import { RateLimitService } from './rate-limit.service';
import { refuse } from './rate-limited';

/**
 * The pre-trust ceiling on the one public write route.
 *
 * Middleware rather than a guard, and the ordering is the entire point.
 * Middleware runs before guards, before interceptors and before the handler, so
 * a flood is turned away here — **before** the signature is verified and
 * **before** anything is enqueued. A guard would run after the route was
 * resolved and would still be doing per-request HMAC work under load, which is
 * the CPU cost this exists to avoid; anything inside the handler would already
 * have touched Postgres.
 *
 * That ordering forces the keying decision. Nothing in the request is trusted
 * yet, so the only identity available is the transport's: the address at the
 * first hop past the platform proxy, plus a coarse global backstop. The
 * tempting alternative — the `team_id` in the body — is unverified at this
 * point, which means an attacker picks it, which means they pick whose budget
 * to exhaust. Reading the body here would invert the whole trust order the
 * Slack adapter is built on, where the signature is checked over raw bytes
 * before anything is parsed.
 *
 * Two ceilings rather than one, because they catch different floods. Per-IP
 * stops one source hammering the route; the global backstop stops the same
 * volume spread thinly across many sources, where every individual bucket stays
 * comfortably under its limit.
 *
 * They are charged in sequence, not concurrently, and that costs something
 * worth stating: a hung Redis is bounded by `RedisService`'s command timeout
 * per call, so this route can wait two of them rather than one before failing
 * open. Slack's acknowledgement budget is three seconds and the pair is a small
 * fraction of it, which is what makes the ordering affordable — and the
 * ordering is what buys the property that a single abusive source is refused on
 * its own key *without* spending the shared budget that everyone else's
 * legitimate traffic depends on. Running them together would let one flooding
 * IP exhaust the global backstop for every workspace.
 *
 * Both fail open, like every other counter here. A Redis outage means Slack
 * ingestion keeps working with no ceiling, which is strictly better than an
 * outage that drops a tenant's inbound support requests on the floor.
 */
@Injectable()
export class SlackRateLimitMiddleware implements NestMiddleware {
  constructor(
    private readonly limits: RateLimitService,
    private readonly config: AppConfigService,
  ) {}

  async use(
    request: Request,
    response: Response,
    next: NextFunction,
  ): Promise<void> {
    const { slackPerIp, slackGlobal } = this.config.rateLimits;
    const ip = clientIp(request);

    const perIp = await this.limits.check(
      (bucket) => slackIpKey(ip, bucket),
      slackPerIp,
    );

    if (perIp.outcome === 'denied') refuse(response, perIp);

    const global = await this.limits.check(
      (bucket) => slackGlobalKey(bucket),
      slackGlobal,
    );

    if (global.outcome === 'denied') refuse(response, global);

    next();
  }
}
