import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { TenancyService, TenantClient } from '../tenancy/tenancy.service';
import { nextRunAfter } from './backoff';
import { JobPayload } from './job-handler';

/**
 * How long a claim is good for before another drainer may take the job back.
 *
 * The lease is what keeps a crash from being permanent. A drainer killed
 * between claiming a row and settling it records no failure and releases no
 * lock — without a lease that row stays `active` forever, and the work is lost
 * as surely as if the queue had never been durable. Generously longer than any
 * plausible handler, because reclaiming a job that is merely slow means running
 * it twice.
 */
export const LEASE_MS = 5 * 60_000;

/**
 * How many jobs one tick claims.
 *
 * A batch rather than one, so a backlog drains in tick-sized bites instead of
 * one job per interval; bounded, so a tick's duration stays predictable and a
 * flood cannot make a single tick run for minutes.
 */
export const CLAIM_BATCH = 20;

/**
 * The ceiling a requested batch is clamped to.
 *
 * The clamp exists because the batch size is inlined into the SQL rather than
 * bound as a parameter — see `claim()` — so it is the one number in that
 * statement that must be proved to be a plain integer before it goes in.
 */
export const MAX_CLAIM_BATCH = 1_000;

export interface EnqueueInput {
  kind: string;
  payload: JobPayload;
  /** Defaults to now — a job that is due immediately. */
  runAfter?: Date;
  maxAttempts?: number;
}

/** A job handed out by `claim()`, with the lease already taken. */
export interface ClaimedJob {
  id: string;
  tenantId: string;
  kind: string;
  payload: JobPayload;
  /** Which attempt this claim is, counting from one. */
  attempts: number;
  maxAttempts: number;
}

/**
 * The queue's data access, and nothing else.
 *
 * Split from the drainer on purpose: this file knows the SQL that makes the
 * queue safe, the drainer knows what to do with a claimed job, and neither
 * needs to be read to understand the other. Every method here is the *same
 * statement* the Spring and FastAPI ports will issue — the safety is in the
 * clauses, not in the language around them.
 */
@Injectable()
export class JobQueueService {
  constructor(private readonly tenancy: TenancyService) {}

  /**
   * Queues work inside the caller's transaction.
   *
   * Taking `tx` rather than opening its own is the same argument `AuditService`
   * makes: the job and the change that warranted it commit together or not at
   * all. A method that opened its own transaction could leave a job to deliver
   * a message that was never written — the classic dual-write failure, arriving
   * as a handler that cannot find its own subject.
   *
   * The tenant is not a parameter. It comes from the armed context via the
   * column's default, so an enqueue site cannot name one, and the policy's
   * `WITH CHECK` refuses a row that tried.
   */
  async enqueue(tx: TenantClient, input: EnqueueInput): Promise<void> {
    await tx.job.create({
      data: {
        kind: input.kind,
        payload: input.payload as Prisma.InputJsonValue,
        ...(input.runAfter ? { runAfter: input.runAfter } : {}),
        ...(input.maxAttempts ? { maxAttempts: input.maxAttempts } : {}),
      },
    });
  }

  /**
   * Takes a batch of due jobs, across every tenant, and leases them.
   *
   * The claim is one statement, and that is what makes it safe. `FOR UPDATE SKIP
   * LOCKED` inside the subselect means a second drainer running the identical
   * query at the identical moment steps over the rows this one has locked rather
   * than blocking on them or — the failure that matters — reading them as
   * available. Two drainers therefore never claim the same job, and they never
   * wait for each other either: the batches are disjoint by construction. No
   * coordinator, no leader election, no advisory lock, because the exclusion is
   * a property of the statement and survives being run from three ports at once.
   *
   * Doing it as a single statement rather than a separate select-then-update
   * closes the window between deciding and marking, in which a second drainer
   * would see the row still `ready`.
   *
   * The selection sits in a **CTE**, and that is load-bearing rather than
   * stylistic. The obvious spelling — `UPDATE … WHERE id IN (SELECT … LIMIT n
   * FOR UPDATE SKIP LOCKED)` — is wrong in a way that is invisible in testing
   * with small numbers: the planner may run that subquery as the inner side of
   * a nested loop, re-executing it per candidate row, and because each
   * re-execution skips what it has already locked it walks straight past the
   * `LIMIT` and claims the entire backlog. A CTE is evaluated exactly once, so
   * the limit means what it says. This was a real bug here, caught by asserting
   * an exact batch size rather than a lower bound.
   *
   * `attempts` increments here, at claim, rather than on failure. A drainer
   * killed mid-handler writes no failure record, so counting failures would let
   * a job that reliably kills the process be retried forever — the poison
   * message that never dies. Counting claims makes even that job reach `dead`.
   *
   * The second disjunct is the lease reclaim: an `active` row whose lock is
   * older than `LEASE_MS` belongs to a drainer that is not coming back.
   *
   * The batch size is the one value here inlined into the SQL rather than bound
   * as a parameter, and that is a workaround rather than a preference: a bound
   * parameter in `LIMIT` does not survive this driver — it silently yields the
   * wrong row count instead of erroring, which is precisely the kind of bug that
   * reaches production, since an unbounded claim looks like a working queue
   * right up until a backlog makes one tick try to drain everything. It is
   * clamped to a plain integer immediately below, so nothing but a number ever
   * reaches the statement.
   */
  async claim(now: Date, limit: number = CLAIM_BATCH): Promise<ClaimedJob[]> {
    const leaseCutoff = new Date(now.getTime() - LEASE_MS);
    const batch = Math.min(
      Math.max(Math.trunc(limit) || CLAIM_BATCH, 1),
      MAX_CLAIM_BATCH,
    );

    return this.tenancy.withScheduler(async (tx) => {
      const rows = await tx.$queryRaw<
        {
          id: string;
          tenant_id: string;
          kind: string;
          payload: JobPayload;
          attempts: number;
          max_attempts: number;
        }[]
      >`
        WITH "due" AS (
          SELECT "id"
            FROM "job"
           WHERE ("status" = 'ready' AND "run_after" <= ${now})
              OR ("status" = 'active' AND "locked_at" < ${leaseCutoff})
           ORDER BY "run_after"
           LIMIT ${Prisma.raw(String(batch))}
           FOR UPDATE SKIP LOCKED
        )
        UPDATE "job"
           SET "status" = 'active',
               "locked_at" = ${now},
               "attempts" = "attempts" + 1,
               "updated_at" = ${now}
          FROM "due"
         WHERE "job"."id" = "due"."id"
        RETURNING "job"."id"::text,
                  "job"."tenant_id"::text,
                  "job"."kind",
                  "job"."payload",
                  "job"."attempts",
                  "job"."max_attempts"
      `;

      return rows.map((row) => ({
        id: row.id,
        tenantId: row.tenant_id,
        kind: row.kind,
        payload: row.payload,
        attempts: row.attempts,
        maxAttempts: row.max_attempts,
      }));
    });
  }

  /** Marks a claimed job finished, releasing its lease. */
  async complete(id: string, now: Date): Promise<void> {
    await this.tenancy.withScheduler(async (tx) => {
      await tx.$executeRaw`
        UPDATE "job"
           SET "status" = 'done',
               "locked_at" = NULL,
               "last_error" = NULL,
               "updated_at" = ${now}
         WHERE "id" = ${id}::uuid
      `;
    });
  }

  /**
   * Records a failure: either a retry at a later `run_after`, or `dead`.
   *
   * Backoff is a column, never a sleep. Nothing is held open across the wait, a
   * restart forgets no pending retry, and the drainer is free the instant it
   * writes this row — which is why a failing integration slows nothing else in
   * the queue down.
   *
   * `dead` is terminal and deliberately not automatic-retryable. A job that has
   * exhausted its attempts is a thing to look at, and the notify-don't-mutate
   * rule applies: nothing about the domain is changed by a delivery giving up.
   */
  async fail(
    job: ClaimedJob,
    error: unknown,
    now: Date,
  ): Promise<{ outcome: 'dead' | 'retry' }> {
    const exhausted = job.attempts >= job.maxAttempts;
    const message = messageOf(error);

    await this.tenancy.withScheduler(async (tx) => {
      if (exhausted) {
        await tx.$executeRaw`
          UPDATE "job"
             SET "status" = 'dead',
                 "locked_at" = NULL,
                 "last_error" = ${message},
                 "updated_at" = ${now}
           WHERE "id" = ${job.id}::uuid
        `;
        return;
      }

      await tx.$executeRaw`
        UPDATE "job"
           SET "status" = 'ready',
               "locked_at" = NULL,
               "last_error" = ${message},
               "run_after" = ${nextRunAfter(job.attempts, now)},
               "updated_at" = ${now}
         WHERE "id" = ${job.id}::uuid
      `;
    });

    return { outcome: exhausted ? ('dead' as const) : ('retry' as const) };
  }
}

/**
 * A failure reduced to something worth writing down.
 *
 * The message alone, not the stack: this column is read by an operator deciding
 * what to do about a `dead` row, and a stack trace from a process that exited
 * days ago answers a different question than "what went wrong".
 */
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
