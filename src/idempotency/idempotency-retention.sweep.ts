import { Injectable } from '@nestjs/common';
import { Sweep } from '../scheduler/sweeper.service';
import { TenancyService } from '../tenancy/tenancy.service';

/**
 * Retention: expired records, removed.
 *
 * A sweep and not a queue job, by the line the scheduler draws — this is
 * internal, idempotent, touches nothing but Postgres and has no network call
 * that could fail, so there is nothing for retry machinery to buy.
 *
 * Worth being precise about what this sweep is *not* responsible for. It is not
 * what makes a key expire: `claim()` tests `expires_at` itself and reclaims a
 * lapsed record in the same statement, so the 24-hour window is honoured to the
 * second whether or not the scheduler is running. This is housekeeping — it
 * keeps the table, and therefore the unique index every side-effecting POST
 * consults, from growing without bound. A sweep that fell a day behind would
 * cost disk and nothing else, which is the right amount of correctness to rest
 * on a tick.
 *
 * The deadline is stamped on each row at claim time rather than computed here
 * from a constant, so a later change to the retention window cannot retroactively
 * expire keys already issued under the old one.
 */
@Injectable()
export class IdempotencyRetentionSweep implements Sweep {
  readonly name = 'idempotency-retention';

  constructor(private readonly tenancy: TenancyService) {}

  async run(now: Date): Promise<void> {
    await this.tenancy.forEachTenant(async (tx) => {
      // Raw, and without `RETURNING`. The rows are being deleted precisely
      // because nobody is entitled to them any more, so reading them back would
      // be work done to be discarded — and this is the one sweep whose row count
      // grows with total traffic rather than with the number of tickets in
      // trouble.
      await tx.$executeRaw`
        DELETE FROM "idempotency_record"
         WHERE "expires_at" <= ${now}::timestamptz
      `;

      // Nothing to announce. Expiry is invisible to clients — a key that lapses
      // simply becomes claimable again — so unlike the SLA and dwell sweeps
      // there is no event and no audit row to emit.
      return [];
    });
  }
}
