import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Type,
} from '@nestjs/common';
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum';
import { getMetadataStorage } from 'class-validator';
import { Request } from 'express';
import { AppException } from 'src/common/errors/app-exception';

/**
 * Metadata Nest records for each decorated handler parameter. The key is
 * `"<paramtype>:<index>"`, and `data` carries the decorator's argument — the
 * property name for `@Query('name')`, `undefined` for a whole-object `@Query()`.
 */
interface RouteArg {
  index: number;
  data?: string;
}

/**
 * Rejects any query parameter a route does not declare.
 *
 * The validation pipe's whitelist already does this — but only on routes that
 * bind a DTO. A route with no `@Query()` parameter has nothing to whitelist
 * against, so it silently accepts anything, which makes "unknown parameters are
 * rejected" true by convention rather than by construction. This guard closes
 * that gap: allowed keys are derived from what the handler actually declares,
 * so a route that declares nothing accepts nothing.
 *
 * Runs as a guard rather than a pipe because guards execute before pipes, which
 * keeps the rejection uniform whether or not a DTO exists.
 */
@Injectable()
export class UnknownQueryParamsGuard implements CanActivate {
  private readonly cache = new WeakMap<object, Set<string> | null>();

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;

    const request = context.switchToHttp().getRequest<Request>();
    const supplied = Object.keys(request.query ?? {});

    if (supplied.length === 0) return true;

    const allowed = this.allowedKeysFor(context);

    // `null` means the route takes the raw query object and vets it itself.
    if (allowed === null) return true;

    const unknown = supplied.filter((key) => !allowed.has(key));

    if (unknown.length > 0) {
      const names = unknown.map((key) => `'${key}'`).join(', ');

      throw new AppException(
        'invalid_filter',
        `Unknown parameter${unknown.length > 1 ? 's' : ''}: ${names}. Parameters are rejected rather than ignored — check for a typo.`,
      );
    }

    return true;
  }

  private allowedKeysFor(context: ExecutionContext): Set<string> | null {
    const handler = context.getHandler();
    const cached = this.cache.get(handler);

    if (cached !== undefined) return cached;

    const computed = this.computeAllowedKeys(context);
    this.cache.set(handler, computed);

    return computed;
  }

  private computeAllowedKeys(context: ExecutionContext): Set<string> | null {
    const args =
      (Reflect.getMetadata(
        ROUTE_ARGS_METADATA,
        context.getClass(),
        context.getHandler().name,
      ) as Record<string, RouteArg> | undefined) ?? {};

    const prototype = context.getClass().prototype as object;

    const paramTypes =
      (Reflect.getMetadata(
        'design:paramtypes',
        prototype,
        context.getHandler().name,
      ) as Type<unknown>[] | undefined) ?? [];

    const allowed = new Set<string>();

    for (const [key, arg] of Object.entries(args)) {
      // Nest keys this metadata as `"<paramtype>:<index>"`.
      if (Number(key.split(':')[0]) !== Number(RouteParamtypes.QUERY)) continue;

      // `@Query('name')` — exactly that one parameter is allowed.
      if (arg.data !== undefined) {
        allowed.add(arg.data);
        continue;
      }

      // Whole-object `@Query()` — every property the DTO declares is allowed.
      const dto = paramTypes[arg.index];

      if (dto === undefined || dto === Object) {
        // An untyped whole-query binding: the handler asked for the raw object,
        // so it owns validating it and this guard steps aside.
        return null;
      }

      for (const property of declaredProperties(dto)) allowed.add(property);
    }

    return allowed;
  }
}

/**
 * The properties a DTO declares, including those inherited from a base class
 * such as `PaginationQuery`.
 */
const declaredProperties = (dto: Type<unknown>): Set<string> => {
  const properties = new Set<string>();

  for (const metadata of getMetadataStorage().getTargetValidationMetadatas(
    dto,
    '',
    true,
    false,
  )) {
    properties.add(metadata.propertyName);
  }

  return properties;
};
