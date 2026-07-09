import { Provider } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { IdempotencyInterceptor } from '../idempotency/idempotency.interceptor';
import { AppExceptionFilter } from './errors/app-exception.filter';
import { buildValidationPipe } from './errors/validation';
import { UnknownQueryParamsGuard } from './pagination/unknown-query.guard';

/**
 * The cross-cutting conventions, as application-wide providers.
 *
 * Registered globally rather than per-controller: the error envelope, the
 * unknown-parameter rejection, input validation, and safe retries are the rule,
 * and a controller must not be able to opt out of them by omission.
 *
 * `IdempotencyInterceptor` belongs here rather than on the side-effecting routes
 * for the same reason as the rest: a per-route opt-in leaves every new endpoint
 * unprotected until somebody remembers, and the symptom of forgetting is a
 * duplicated effect rather than a failing request. The opt-in that does exist is
 * the client's — it sends a key, or it does not.
 *
 * Exported as one list so tests mount exactly what production mounts — a
 * convention asserted against a fixture is then the same convention a real
 * resource gets, and adding a fifth global is one edit rather than two.
 */
export const GLOBAL_PROVIDERS: Provider[] = [
  { provide: APP_FILTER, useClass: AppExceptionFilter },
  { provide: APP_GUARD, useClass: UnknownQueryParamsGuard },
  { provide: APP_PIPE, useFactory: () => buildValidationPipe() },
  { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
];
