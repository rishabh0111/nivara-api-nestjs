import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Response } from 'express';
import { AuthenticatedRequest, PRINCIPAL_KEY } from '../auth/auth.guard';
import { AppConfigService } from '../config/app-config.service';
import { authenticatedKey } from './rate-limit-keys';
import { RateLimitService } from './rate-limit.service';
import { refuse } from './rate-limited';

/**
 * One uniform ceiling per authenticated principal.
 *
 * A guard rather than middleware, and it has to be: the key is built from the
 * `RequestPrincipal`, and the principal is resolved by `AuthGuard`. Middleware
 * runs before guards, so this is unaskable there — the earliest point at which
 * "who is this?" has a server-determined answer is after the authentication
 * guard, which is where this is registered.
 *
 * Uniform on purpose. Every principal kind gets the same budget, and there is
 * no per-route or per-scope variation, because ticket 18 deferred both. A table
 * of ceilings is easy to add and impossible to remove once clients depend on
 * the differences, so it waits until real traffic shows which endpoint actually
 * needs its own number.
 *
 * It reads the unified principal and never branches on kind, which is why a
 * staff User, a portal Contact, a widget visitor and a service token are limited
 * by this one implementation rather than by four that drift.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly limits: RateLimitService,
    private readonly config: AppConfigService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // WebSocket connections are limited at connect by the gateway's own
    // authentication, not per-frame here. A socket is one request to this guard
    // and would consume one unit of a per-minute budget for a connection that
    // may live for hours, which measures nothing useful.
    if (context.getType() !== 'http') return true;

    const http = context.switchToHttp();
    const principal = http.getRequest<AuthenticatedRequest>()[PRINCIPAL_KEY];

    // No principal means a `@Public()` route: sign-in, refresh, widget session
    // minting, the Slack endpoint. There is no per-principal budget to charge
    // because there is no principal, and the one public route that carries real
    // risk — Slack — has its own pre-trust limiter ahead of authentication
    // entirely. The rest are covered by ticket 18's deliberate scope: this is
    // the authenticated ceiling.
    if (!principal) return true;

    const decision = await this.limits.check(
      (bucket) => authenticatedKey(principal, bucket),
      this.config.rateLimits.authenticated,
    );

    if (decision.outcome === 'denied') {
      refuse(http.getResponse<Response>(), decision);
    }

    return true;
  }
}
