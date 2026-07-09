import {
  CallHandler,
  ExecutionContext,
  HttpStatus,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Response } from 'express';
import { Observable, from, of, switchMap, tap } from 'rxjs';
import { AuthenticatedRequest, PRINCIPAL_KEY } from '../auth/auth.guard';
import { AppException } from '../common/errors/app-exception';
import { IdempotencyKey, IdempotencyService } from './idempotency.service';
import { httpScope, idempotencyContextFor } from './idempotency-scope';
import { requestFingerprint } from './request-fingerprint';

/** Set on a replayed response, so a client can tell a cached answer from a fresh one. */
export const REPLAYED_HEADER = 'Idempotency-Replayed';

/** The header a caller opts in with. */
const KEY_HEADER = 'idempotency-key';

/**
 * A key long enough to be unguessable and short enough to index. Generous at
 * both ends: this rejects obvious abuse, not unusual-but-honest key formats.
 */
const MAX_KEY_LENGTH = 255;

/**
 * `Idempotency-Key`, as a global interceptor.
 *
 * Global rather than a decorator on each side-effecting route, for the reason
 * every other convention in `GLOBAL_PROVIDERS` is: opting in per route means a
 * new endpoint is unprotected until somebody remembers, and "somebody forgot"
 * would show up as a duplicated charge rather than as a failing request. Here
 * the *client* opts in per request, which is the right place for the choice —
 * only the client knows whether it is retrying.
 *
 * An interceptor rather than middleware, because it needs the principal, and the
 * principal is resolved by a guard. Guards run before interceptors and after
 * middleware, so this is the earliest point at which "who is retrying?" has an
 * answer — and that answer is half of the scope.
 *
 * Three responses it can produce without the handler running at all:
 *
 *   * **replay** — the original's status and body, verbatim, plus the header
 *     above. The effect is not re-executed.
 *   * **409 `idempotency_in_flight`** — the original has not finished. Distinct
 *     from `conflict` on purpose: a client can retry this one, whereas a
 *     resource conflict means stop.
 *   * **422 `idempotency_key_reused`** — the key is held against a different
 *     body. Refused rather than answered, because answering would report success
 *     for an operation that was never attempted.
 *
 * And an absent header is none of these: it is simply passed through. The
 * guarantee is opt-in, so no key means no promise rather than a rejection.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

  constructor(private readonly idempotency: IdempotencyService) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> | Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest>();

    // POST only. GET and HEAD are safe, DELETE is idempotent by its own
    // definition, and PATCH transitions are already guarded by the state
    // machine, which refuses the second application of a move. POST is the one
    // verb whose repetition genuinely creates a second thing.
    if (request.method !== 'POST') return next.handle();

    const key = headerValue(request.headers[KEY_HEADER]);

    if (key === null) return next.handle();

    // `malformed_request` rather than `validation_failed`: the catalog reserves
    // the latter for a body that failed validation, with `details` carrying one
    // entry per offending *field*. A header is not a field, and borrowing the
    // 422 would put a non-field into a shape clients parse per-field.
    if (key.length > MAX_KEY_LENGTH) {
      throw new AppException(
        'malformed_request',
        `Idempotency-Key must be at most ${MAX_KEY_LENGTH} characters.`,
      );
    }

    const principal = request[PRINCIPAL_KEY];

    // No principal means a `@Public()` route — sign-in, refresh, widget session
    // minting. There is no tenant to scope a record to and no caller to
    // attribute it to, so there is nothing to key on. Those routes are also the
    // ones where a duplicate is harmless: each mints a fresh credential and
    // supersedes nothing.
    if (!principal) return next.handle();

    // `originalUrl` rather than `path`, so the query string is inside the scope.
    // The fingerprint covers the body alone, so with `path` two POSTs differing
    // only by a query parameter would be indistinguishable and one could replay
    // as the other.
    const scope = httpScope(principal, request.method, request.originalUrl);

    return from(
      this.idempotency.claim(
        idempotencyContextFor(principal),
        { scope, key },
        requestFingerprint(request.body),
      ),
    ).pipe(
      switchMap((claim) => {
        if (claim.outcome === 'mismatch') {
          throw new AppException(
            'idempotency_key_reused',
            'This Idempotency-Key was already used for a request with a different body. Use a fresh key for a different request.',
          );
        }

        if (claim.outcome === 'in_flight') {
          throw new AppException(
            'idempotency_in_flight',
            'An earlier request with this Idempotency-Key is still running. Retry shortly; its effect will happen only once.',
          );
        }

        if (claim.outcome === 'replay') {
          return this.replay(http.getResponse<Response>(), claim.response);
        }

        return this.runAndSettle(context, next, principal, { scope, key });
      }),
    );
  }

  /**
   * Answer from the record instead of running the handler.
   *
   * The status is set on the response object rather than returned. Nest stamps
   * the route's default (201 for a POST) *before* the interceptor chain, and the
   * handler-response function it builds is constructed without a status
   * argument, so the adapter's `reply()` sees `undefined` and leaves whatever is
   * on the response alone. Writing it here is therefore what decides the status
   * a replay carries. That is an internal of `RouterExecutionContext` rather than
   * a documented contract, which is why `idempotency.int-spec.ts` replays a
   * record whose stored code differs from the route default — if a future Nest
   * starts re-stamping, that test goes red rather than the behaviour going
   * quietly wrong.
   *
   * A record with no stored response is one an event-dedupe consumer completed;
   * it should never reach an HTTP replay. Answering 200 with an empty body is
   * the conservative reading — the request was handled — and it is much better
   * than re-running an effect that already happened.
   */
  private replay(
    response: Response,
    stored: { code: number; body: unknown } | null,
  ): Observable<unknown> {
    response.status(stored?.code ?? HttpStatus.OK);
    response.setHeader(REPLAYED_HEADER, 'true');

    return of(stored?.body ?? null);
  }

  /**
   * Run the handler with the claim held, then settle it.
   *
   * Settling on failure is a `release`, not a `complete`, and the asymmetry is
   * the point. An error response *is* an answer — a 404 or a validation failure
   * is deterministic and replaying it is honest — but it is deliberately not
   * cached here, because the far more common error is a transient one and a
   * cached 500 would hold the key for a day against exactly the retry it exists
   * to permit. Releasing costs a client at most one extra execution of a request
   * that did not take effect; caching costs it the ability to retry at all.
   *
   * Every write path in this application is a transaction, so a request that
   * threw left nothing behind for the retry to duplicate.
   */
  private runAndSettle(
    context: ExecutionContext,
    next: CallHandler,
    principal: NonNullable<AuthenticatedRequest[typeof PRINCIPAL_KEY]>,
    ref: IdempotencyKey,
  ): Observable<unknown> {
    const tenantContext = idempotencyContextFor(principal);
    const response = context.switchToHttp().getResponse<Response>();

    return next.handle().pipe(
      // `switchMap` rather than `tap`, so the response is not sent until the
      // record is durably marked `completed`. The other order has a real window:
      // a client that receives a 201 and immediately retries could beat the
      // update and be told 409 by its own original request.
      switchMap((body) =>
        from(
          this.idempotency.complete(tenantContext, ref, {
            code: response.statusCode,
            body,
          }),
        ).pipe(switchMap(() => of(body))),
      ),
      tap({
        error: () => {
          // Not awaited, and it has to be that way: this runs while an error is
          // already propagating, and awaiting it would let a failure to release
          // replace the real error with a less useful one. An unreleased record
          // is recoverable — it expires — so the original error is the more
          // valuable of the two.
          //
          // `.catch()` rather than `void`, because a rejection with no handler
          // takes the process down under Node's default policy. Logged rather
          // than swallowed, since a release that keeps failing is why a caller
          // would be seeing 409s they cannot explain.
          this.idempotency
            .release(tenantContext, ref)
            .catch((error: unknown) =>
              this.logger.error(
                `Failed to release idempotency key for ${ref.scope}`,
                error instanceof Error ? error.stack : String(error),
              ),
            );
        },
      }),
    );
  }
}

/**
 * Express types a header as `string | string[]`, and a duplicated
 * `Idempotency-Key` is a malformed request rather than a choice to make on the
 * caller's behalf — picking one silently could key a retry differently from its
 * original.
 */
const headerValue = (raw: string | string[] | undefined): string | null => {
  if (Array.isArray(raw)) {
    throw new AppException(
      'malformed_request',
      'Idempotency-Key was supplied more than once.',
    );
  }

  const value = raw?.trim();

  return value ? value : null;
};
