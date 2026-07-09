import { Injectable } from '@nestjs/common';
import { isUniqueViolation } from '../common/errors/prisma-errors';
import { Prisma } from '../generated/prisma/client';
import { TenancyService } from '../tenancy/tenancy.service';
import { TenantContext } from '../tenancy/tenant-context';

/**
 * How many times `claim()` may start over when the record it went to read has
 * been deleted underneath it. See `attemptClaim()`.
 */
const RECLAIM_ATTEMPTS = 2;

/** Which record is being claimed: what kind of thing, and which one. */
export interface IdempotencyKey {
  /**
   * The partition this key lives in. For an HTTP caller it is the principal
   * reference and the request line; for an event consumer, a name of its own.
   * Server-derived in both cases — a scope taken from input would let a caller
   * choose whose records it collides with.
   */
  scope: string;
  /** The key itself, opaque and compared verbatim. */
  key: string;
}

/** What a completed request left behind for its replays to be answered with. */
export interface IdempotentResponse {
  code: number;
  body: unknown;
}

/**
 * The four things that can be true when a key is claimed.
 *
 * A closed union rather than a boolean plus some out-parameters, because the
 * caller has to do something different in each case and a shape that let one be
 * forgotten would fail by *silently executing the effect twice* — which is the
 * one outcome this whole module exists to prevent.
 */
export type IdempotencyClaim =
  /** Nobody holds this key. Do the work, then `complete()` or `release()`. */
  | { outcome: 'fresh' }
  /** It is done, and this is what it answered. Do not execute anything. */
  | { outcome: 'replay'; response: IdempotentResponse | null }
  /** Someone is doing it right now. There is nothing to answer with yet. */
  | { outcome: 'in_flight' }
  /** The key is held against a *different* request. Refuse it. */
  | { outcome: 'mismatch' };

/**
 * The idempotency store: claim a key, then settle it.
 *
 * Deliberately knows nothing about HTTP. It takes a `TenantContext` rather than
 * a principal, a `scope` rather than a route, and an opaque `IdempotentResponse`
 * rather than an express reply — so the interceptor is one consumer of it rather
 * than its implementation. The second consumer is inbound event dedupe, which
 * has no request line, no header and no response to cache, and needs only
 * `claim()` returning something other than `fresh` to know it should drop the
 * event.
 *
 * Every method opens its own transaction, and that is not an oversight to be
 * optimised away later: an in-flight claim has to be *visible to a concurrent
 * duplicate* before the guarded work runs, so the claim cannot ride the caller's
 * transaction. It is the one place in this codebase where sharing a transaction
 * would be wrong rather than merely wasteful.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly tenancy: TenancyService) {}

  /**
   * Take the key if it is free, and otherwise say why it is not.
   *
   * The insert is the arbiter. Two requests racing with the same key are in
   * separate transactions by construction, so nothing in this process is in a
   * position to see the race — the only thing that can adjudicate it is the
   * unique index, and the loser learns it lost by catching the violation.
   *
   * `requestHash` is optional, and its absence means "do not compare payloads"
   * rather than "compare against nothing". That is what the event-dedupe
   * consumer needs: a redelivered Slack event carries the same `event_id` in an
   * envelope that is not guaranteed byte-identical, so hashing it would report a
   * `mismatch` — a key-reuse *bug* — for what is in fact the ordinary
   * at-least-once redelivery the consumer exists to absorb. An HTTP caller
   * always supplies one, because there a changed body genuinely is a bug.
   */
  async claim(
    context: TenantContext,
    ref: IdempotencyKey,
    requestHash?: string,
  ): Promise<IdempotencyClaim> {
    return this.attemptClaim(context, ref, requestHash, RECLAIM_ATTEMPTS);
  }

  /**
   * `remaining` bounds the one case that can legitimately start over: a record
   * that vanished between the insert and the read. Each retry needs the row to
   * be deleted again in the same narrow window, so two attempts is already
   * generous — the bound exists because unbounded recursion on the hottest path
   * in the request pipeline is not a risk worth taking to save a counter.
   */
  private async attemptClaim(
    context: TenantContext,
    { scope, key }: IdempotencyKey,
    requestHash: string | undefined,
    remaining: number,
  ): Promise<IdempotencyClaim> {
    try {
      await this.tenancy.withTenant(context, (tx) =>
        tx.idempotencyRecord.create({
          data: { scope, key, requestHash: requestHash ?? '' },
        }),
      );

      return { outcome: 'fresh' };
    } catch (error) {
      // A failed statement aborts the surrounding Postgres transaction, so the
      // losing branch cannot continue inside the one that just failed. Hence a
      // second transaction below rather than a `catch` a few lines up.
      if (!isUniqueViolation(error)) throw error;
    }

    return this.tenancy.withTenant(context, async (tx) => {
      // Expiry is enforced here, not only by the sweep. The sweep runs on a
      // tick, so leaving this to it would make "records expire after 24 hours"
      // mean "after 24 hours and up to a tick", and a caller whose key had
      // genuinely lapsed would be refused for as long as the scheduler happened
      // to be behind. Reclaiming in the same statement that tests the deadline
      // also makes it race-free: two requests arriving on a lapsed key contend
      // on the row lock, and exactly one sees a row count of 1.
      const reclaimed = await tx.$executeRaw`
        UPDATE "idempotency_record"
           SET "request_hash" = ${requestHash ?? ''},
               "status" = 'in_progress',
               "response_code" = NULL,
               "response_body" = NULL,
               "actor_kind" = current_actor_kind(),
               "actor_id" = current_actor_id(),
               "created_at" = CURRENT_TIMESTAMP,
               "expires_at" = CURRENT_TIMESTAMP + idempotency_retention()
         WHERE "scope" = ${scope}
           AND "key" = ${key}
           AND "expires_at" <= CURRENT_TIMESTAMP
      `;

      if (reclaimed > 0) return { outcome: 'fresh' };

      const held = await tx.idempotencyRecord.findFirst({
        where: { scope, key },
      });

      // Gone between the two transactions — the sweep deleted it, or a request
      // that had reclaimed it released it. Reporting `in_flight` here would be a
      // lie in the one direction that matters: it would tell a caller to wait
      // for an original that does not exist, and a retry loop would bounce on it
      // indefinitely. Nobody holds the key, so start over and take it properly;
      // the insert is what establishes the claim, not this read.
      if (!held) {
        return remaining > 0
          ? this.attemptClaim(
              context,
              { scope, key },
              requestHash,
              remaining - 1,
            )
          : // Out of attempts. `in_flight` is the conservative answer: it is
            // retryable by the client and cannot cause a double effect, which is
            // the property to preserve when we have run out of ways to be sure.
            { outcome: 'in_flight' };
      }

      // Checked before the status, because it is the more serious disagreement.
      // A caller who reused a key against a changed body has a bug, and the
      // worst possible response is the *other* request's cached success: it
      // would report that an operation completed which was never attempted.
      //
      // Skipped entirely when the caller supplied no hash — see `claim()`.
      if (requestHash !== undefined && held.requestHash !== requestHash) {
        return { outcome: 'mismatch' };
      }

      if (held.status === 'in_progress') return { outcome: 'in_flight' };

      return {
        outcome: 'replay',
        response:
          held.responseCode === null
            ? null
            : { code: held.responseCode, body: held.responseBody },
      };
    });
  }

  /**
   * Settle a claim: the work happened, and this is what it answered.
   *
   * `response` is optional because the event-dedupe consumer has nobody to
   * answer — it completes a record purely to record that the event was handled,
   * and a later redelivery reads `replay` with a null response and drops.
   *
   * `updateMany` rather than `update`, so a record the sweep removed while the
   * request was running is a no-op rather than a 500 thrown *after* the effect
   * already succeeded. Losing the replay window is a much smaller harm than
   * failing a request whose work is already committed.
   */
  async complete(
    context: TenantContext,
    { scope, key }: IdempotencyKey,
    response?: IdempotentResponse,
  ): Promise<void> {
    await this.tenancy.withTenant(context, (tx) =>
      tx.idempotencyRecord.updateMany({
        where: { scope, key, status: 'in_progress' },
        data: {
          status: 'completed',
          responseCode: response?.code ?? null,
          responseBody:
            response === undefined
              ? Prisma.DbNull
              : (response.body as Prisma.InputJsonValue),
        },
      }),
    );
  }

  /**
   * Give the key back: the request produced no answer, so nothing should be
   * replayed and the caller must be free to try again.
   *
   * This is why `IdempotencyStatus` has no `failed` member. A key held forever
   * by a request that hit a transient fault would be a key permanently poisoned
   * by exactly the kind of blip retries exist for — the caller would retry, be
   * told the request already happened, and believe an effect occurred that never
   * did. Deleting is the honest reset.
   *
   * Guarded on `in_progress` so this can only ever drop *our own* unfinished
   * claim, never a completed record somebody is still entitled to replay.
   */
  async release(
    context: TenantContext,
    { scope, key }: IdempotencyKey,
  ): Promise<void> {
    await this.tenancy.withTenant(context, (tx) =>
      tx.idempotencyRecord.deleteMany({
        where: { scope, key, status: 'in_progress' },
      }),
    );
  }
}
