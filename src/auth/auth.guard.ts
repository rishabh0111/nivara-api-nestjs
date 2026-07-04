import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { AppException } from '../common/errors/app-exception';
import { isServiceToken } from '../service-tokens/service-token-format';
import { ServiceTokenService } from '../service-tokens/service-token.service';
import { isWidgetToken } from '../widget/widget-session-token';
import { WidgetSessionService } from '../widget/widget-session.service';
import { AccessTokenService } from './access-token.service';
import { RequestPrincipal } from './request-principal';

/**
 * Exported because the authorization guard reads it too: a public route has no
 * principal, so there is nothing there to authorize either. One key rather than
 * two means a route cannot be public to one guard and closed to the other.
 */
export const PUBLIC_KEY = 'auth:public';

/**
 * Opens a route to unauthenticated callers.
 *
 * An allowlist rather than a `@Protected()` denylist, because the two fail in
 * opposite directions: forgetting this decorator makes a public endpoint
 * return 401 and someone reports it within the hour, while forgetting the
 * inverse would publish a tenant's data with nothing to notice.
 */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(PUBLIC_KEY, true);

/** Where the resolved principal is stashed for the param decorator to read. */
export const PRINCIPAL_KEY = 'nivaraPrincipal';

export interface AuthenticatedRequest extends Request {
  [PRINCIPAL_KEY]?: RequestPrincipal;
}

/**
 * The authentication layer: credential in, `RequestPrincipal` out.
 *
 * Registered globally, so every route is closed unless it says otherwise. It
 * resolves the principal and nothing else — it does not decide what that
 * principal may do, which is the authorization guard's job, and it does not
 * open a transaction, which is the handler's.
 *
 * Three credential types, told apart by the bearer value's prefix and
 * converging on the same `RequestPrincipal` — so everything downstream of this
 * file stays unaware that more than one kind of caller exists. This is the only
 * thing in the request path that branches on credential type: `withTenant()`
 * and the permission guard are shared and cannot tell which principal they are
 * serving, which is what stops the kinds drifting apart in what they may do.
 *
 * The prefix is routing, not authentication. It decides which verifier gets the
 * value so that one credential type is not tried against every key in the
 * process; it grants nothing, and a staff token wearing a widget prefix fails
 * at the signature a moment later because the two surfaces are signed by
 * different keys.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly accessTokens: AccessTokenService,
    private readonly widgetSessions: WidgetSessionService,
    private readonly serviceTokens: ServiceTokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = bearerToken(request.headers.authorization);

    if (!token) throw unauthenticated();

    const principal = await this.resolve(token);

    if (!principal) throw unauthenticated();

    request[PRINCIPAL_KEY] = principal;

    return true;
  }

  /**
   * Bearer value to principal, by prefix.
   *
   * A chain rather than a map, because the staff token is the one with no
   * prefix of its own — it is a bare JWT — so it can only be the fallthrough.
   * Each verifier answers `null` for anything it cannot use, and this method
   * has no opinion about why: three different reasons for "no" would be three
   * different 401s to distinguish from the outside.
   */
  private async resolve(token: string): Promise<RequestPrincipal | null> {
    if (isServiceToken(token)) return this.serviceTokens.verify(token);
    if (isWidgetToken(token)) return this.widgetSessions.verify(token);

    return this.accessTokens.verify(token);
  }
}

const unauthenticated = (): AppException =>
  new AppException(
    'unauthenticated',
    'A valid access token is required for this operation.',
  );

/**
 * Pulls the credential out of an `Authorization` header.
 *
 * One header for every principal type, by design — service tokens will arrive
 * on this same line and be told apart by their `nvk_live_` prefix rather than
 * by a scheme of their own.
 */
const bearerToken = (header: string | undefined): string | null => {
  if (!header) return null;

  const [scheme, ...rest] = header.split(' ');

  if (scheme?.toLowerCase() !== 'bearer') return null;

  const value = rest.join(' ').trim();

  return value === '' ? null : value;
};
