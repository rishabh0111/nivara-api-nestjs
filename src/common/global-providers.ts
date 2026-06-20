import { Provider } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { AppExceptionFilter } from './errors/app-exception.filter';
import { buildValidationPipe } from './errors/validation';
import { UnknownQueryParamsGuard } from './pagination/unknown-query.guard';

/**
 * The cross-cutting conventions, as application-wide providers.
 *
 * Registered globally rather than per-controller: the error envelope, the
 * unknown-parameter rejection, and input validation are the rule, and a
 * controller must not be able to opt out of them by omission.
 *
 * Exported as one list so tests mount exactly what production mounts — a
 * convention asserted against a fixture is then the same convention a real
 * resource gets, and adding a fourth global is one edit rather than two.
 */
export const GLOBAL_PROVIDERS: Provider[] = [
  { provide: APP_FILTER, useClass: AppExceptionFilter },
  { provide: APP_GUARD, useClass: UnknownQueryParamsGuard },
  { provide: APP_PIPE, useFactory: () => buildValidationPipe() },
];
