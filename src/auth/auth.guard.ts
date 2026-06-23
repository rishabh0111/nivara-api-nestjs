import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { AppException } from '../common/errors/app-exception';
import { AccessTokenService } from './access-token.service';
import { RequestPrincipal } from './request-principal';

const PUBLIC_KEY = 'auth:public';

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
 * Today there is exactly one credential type. Service tokens add a branch
 * *here*, distinguished by the bearer value's prefix, and converge on the same
 * `RequestPrincipal` — so everything downstream of this file stays unaware
 * that a second kind of caller exists.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly accessTokens: AccessTokenService,
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

    const principal = await this.accessTokens.verify(token);

    if (!principal) throw unauthenticated();

    request[PRINCIPAL_KEY] = principal;

    return true;
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
