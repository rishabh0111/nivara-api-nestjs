-- ---------------------------------------------------------------------------
-- Scheduler runtime: Postgres as the queue
-- ---------------------------------------------------------------------------
--
-- One table, and everything interesting about it is a WHERE clause.
--
-- The requirement is that work accepted from outside survives a restart of the
-- web process — an inbound Slack event is acknowledged in under three seconds
-- and processed afterwards, and the gap between the ack and the effect is
-- exactly what must not be lost. A row in Postgres satisfies that for free.
--
-- Postgres rather than Redis/BullMQ, for the reason the rest of this schema
-- keeps its invariants in SQL: `SELECT … FOR UPDATE SKIP LOCKED` is the claim,
-- and it is the *same claim* in all three ports. Durability and mutual exclusion
-- become properties of the database, inherited rather than reimplemented. The
-- alternative would make both Redis-shaped, and the free-tier connection caps
-- fight BullMQ's persistent blocking connection besides. `pg_cron` was the third
-- option and is unavailable on Neon, so the *store* is Postgres-native even
-- though the *clock* cannot be — the clock is an interval in the web process.
--
-- Note what the queue deliberately does not carry: the SLA breach latch and the
-- 7-day dwell transitions. Those are internal, idempotent, and cannot fail, so
-- the sweep applies them directly in its own transaction. Retry machinery
-- belongs only where a network call can actually fail.

CREATE TYPE "job_status" AS ENUM ('ready', 'active', 'done', 'dead');

CREATE TABLE "job" (
    "id" UUID NOT NULL,

    -- Defaulted from the armed context rather than supplied, as on `audit_log`.
    -- Work is queued from inside the transaction that decided to queue it, so
    -- the tenant is already established; naming it again at the insert site
    -- could only introduce a disagreement, and the policy's `WITH CHECK` is
    -- what refuses one.
    "tenant_id" UUID NOT NULL DEFAULT NULLIF(current_setting('app.current_tenant', true), '')::uuid,

    -- A routing key into the application's handler registry, not a closed
    -- database vocabulary. Kinds arrive with integrations, and an enum here
    -- would make adding one a migration in three ports; an unrecognized kind
    -- dead-letters at claim time instead, which is where an operator would look
    -- anyway.
    "kind" TEXT NOT NULL,

    -- Ids the handler re-reads under a tenant context, never a copy of the row.
    -- See the scheduler policy below for why that convention is load-bearing
    -- rather than tidy.
    "payload" JSONB NOT NULL,

    -- Scheduling and backoff, in one column. A retry is a row with a later
    -- `run_after` — nothing sleeps, nothing is held open, and a restart loses no
    -- pending retry because the wait is data rather than a timer.
    "run_after" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    -- Incremented when a claim is handed out, not when one fails. A worker
    -- killed mid-handler records no failure, so counting failures would retry a
    -- job that reliably crashes the process forever.
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,

    "status" "job_status" NOT NULL DEFAULT 'ready',

    -- Null unless `active`. This is what makes a claim a lease rather than a
    -- permanent seizure: a drainer that dies between claiming and settling
    -- leaves a row nothing would ever pick up again, and the reclaim predicate
    -- in the drainer reads this column to fix that.
    "locked_at" TIMESTAMPTZ(3),

    "last_error" TEXT,

    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "job" ADD CONSTRAINT "job_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Ordered as the claim filters and then scans: equality on status, range on the
-- due time. The claim is the only read on this table that has to be fast, and it
-- runs every few seconds forever.
CREATE INDEX "job_status_run_after_idx" ON "job"("status", "run_after");

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
--
-- Two policies, because this table has two legitimate readers and they want
-- opposite things. Enqueueing happens inside a tenant's own transaction and must
-- be confined to that tenant, exactly like every other table here. Draining is
-- one loop serving every tenant at once — it cannot know which tenant to arm,
-- because deciding that is what the claim is *for*.
--
-- Postgres OR-s permissive policies, so the two coexist without either weakening
-- the other. The important part is the blast radius of the second one, and it is
-- bounded by three separate things:
--
--   * `app.scheduler` is armed by exactly one method — `withScheduler()` — which
--     arms no tenant at all. There is no request path to it: no guard, no
--     controller, and nothing that turns a credential into it.
--
--   * Only this table has a policy naming that setting. A scheduler context is
--     therefore not a skeleton key; it can read the queue and *nothing else*. A
--     ticket, a message, a contact are all invisible under it, and there is a
--     test that asserts precisely that, plus one that scans `pg_policies` to
--     prove no second table has quietly grown the same clause.
--
--   * The payload convention — ids, never content — means what that context can
--     read across tenants is routing information. The handler re-reads the
--     actual rows under `withTenant()`, back inside normal isolation.
--
-- `NOT current_actor_is_contact()` on the tenant clause, matching `service_token`
-- and `note`: nothing customer-facing enqueues or reads work, and a Contact
-- enumerating a tenant's pending integration work is a cheap thing to foreclose.

ALTER TABLE "job" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "job" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "job"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid
    AND NOT current_actor_is_contact()
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid
    AND NOT current_actor_is_contact()
  );

-- The drainer's cross-tenant view. `= 'on'` rather than a truthiness test, and
-- `current_setting(..., true)` so an unarmed context yields NULL — which is not
-- true, so this policy admits nothing by default in exactly the way the tenant
-- clause does.
--
-- No `WITH CHECK` counterpart is needed for correctness — the drainer only
-- claims and settles rows that already exist — but it is here because a policy
-- with a `USING` and no `WITH CHECK` silently reuses `USING` for writes, and
-- stating it is how a later reader knows that was intended rather than missed.
CREATE POLICY scheduler_drain ON "job"
  USING (current_setting('app.scheduler', true) = 'on')
  WITH CHECK (current_setting('app.scheduler', true) = 'on');

-- DELETE is granted for the reason it is granted elsewhere — the privilege exists
-- so a considered write path can arrive later. Nothing deletes jobs today:
-- `done` and `dead` rows are the record of what the queue did, and pruning them
-- is an operational decision that has not been made yet.
GRANT SELECT, INSERT, UPDATE, DELETE ON "job" TO app_user;
