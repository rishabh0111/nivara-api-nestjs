import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  AuthenticatedRequest,
  PRINCIPAL_KEY,
  PUBLIC_KEY,
} from '../auth/auth.guard';
import { AppException } from '../common/errors/app-exception';
import { Permission, permissionsFor } from './permissions';
import {
  AUTHENTICATED_ONLY_KEY,
  PERMISSION_KEY,
} from './require-permission.decorator';

/**
 * The authorization layer: principal in, verdict out.
 *
 * Runs after `AuthGuard`, and knows nothing about credentials — by the time it
 * sees a request, someone else has already decided who is asking. It asks one
 * question of that principal, through `permissionsFor()`, and so is blind to
 * whether it is serving a User or (later) a ServiceToken. That blindness is the
 * design: two principal types with one authorization path cannot drift apart in
 * what they are allowed to do.
 *
 * It **fails closed**. An operation carrying no explicit requirement is
 * refused, so the failure mode of forgetting a decorator is a 403 someone
 * reports rather than an endpoint quietly open to every authenticated caller.
 * `@AuthenticatedOnly()` is how an operation says it means to have no
 * requirement.
 *
 * Row-level security sits beneath both guards regardless. A bug here refuses
 * work that should have been allowed, or allows a call that should have been
 * refused — but it cannot show one tenant another tenant's rows.
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  private readonly logger = new Logger(PermissionGuard.name);

  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const sources = [context.getHandler(), context.getClass()];

    const isPublic = this.reflector.getAllAndOverride<boolean>(
      PUBLIC_KEY,
      sources,
    );

    // Nothing authenticated the caller, so there is no authority to weigh.
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = request[PRINCIPAL_KEY];

    // Unreachable while the guards run in order, and cheap insurance against
    // the day they do not: without a principal this guard has no basis for any
    // verdict, and inventing one would be worse than refusing.
    if (!principal) {
      throw new AppException(
        'unauthenticated',
        'A valid access token is required for this operation.',
      );
    }

    const required = this.reflector.getAllAndOverride<Permission | undefined>(
      PERMISSION_KEY,
      sources,
    );

    if (!required) {
      const authenticatedOnly = this.reflector.getAllAndOverride<boolean>(
        AUTHENTICATED_ONLY_KEY,
        sources,
      );

      if (authenticatedOnly) return true;

      // Logged as an error because it is one — a route reached production
      // without an authority decision having been made about it. The caller
      // gets a plain refusal; the operator gets the reason.
      this.logger.error(
        `Refused ${context.getClass().name}.${context.getHandler().name}: it declares no @RequiresPermission() and is not @AuthenticatedOnly() or @Public().`,
      );

      throw forbidden();
    }

    if (!permissionsFor(principal).has(required)) throw forbidden();

    return true;
  }
}

/**
 * One refusal for both cases, deliberately.
 *
 * A caller learning *which* permission they lack learns the shape of the
 * tenant's authority model, and a caller able to tell "you may not" from "this
 * endpoint is misconfigured" learns where to keep probing. Neither is
 * actionable to a legitimate client: both mean ask an admin.
 */
const forbidden = (): AppException =>
  new AppException(
    'forbidden',
    'This operation requires a permission your role does not hold.',
  );
