import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import { AuthenticatedRequest, PRINCIPAL_KEY } from './auth.guard';
import { RequestPrincipal } from './request-principal';

/**
 * The authenticated caller, as a handler parameter.
 *
 * Non-optional in its return type, and safely so: the global `AuthGuard` runs
 * before any handler and either sets a principal or refuses the request, so a
 * handler that receives one has one. The exception is a `@Public()` route,
 * where the guard returns early — asking for a principal there is a
 * programming error rather than a runtime condition to branch on, so it throws
 * rather than handing back a value that lies about being present.
 */
export const Principal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): RequestPrincipal => {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = request[PRINCIPAL_KEY];

    if (!principal) {
      throw new Error(
        'No principal on the request. @Principal() is only valid on routes the AuthGuard protects — a @Public() route has no authenticated caller to describe.',
      );
    }

    return principal;
  },
);
