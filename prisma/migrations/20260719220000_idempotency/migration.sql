-- ---------------------------------------------------------------------------
-- Idempotency: safe retries on side-effecting requests
-- ---------------------------------------------------------------------------
--
-- One table, and the guarantee is the unique constraint on it. A caller that
-- supplies `Idempotency-Key` on a POST gets first-writer-wins: the first request
-- inserts the row and runs, and every later request carrying that key finds the
-- row already there and is answered from it rather than executing again.
--
-- Postgres rather than Redis, for the reason the queue is Postgres. The window
-- being durable is the entire point — a replay window that a cache eviction can
-- silently drop is a replay window that silently double-charges somebody — and
-- the invariant here is a unique index, which is the same unique index in all
-- three ports rather than a Redis-shaped thing each one re-solves.
--
-- Two consumers, one table, and the second is the reason `scope` exists as a
-- column rather than the route being the key. The API caller keys on the route
-- it called and the header it sent; inbound Slack event dedupe keys on
-- `slack:event` and the delivered `event_id`. Neither is a special case of the
-- other, and both want exactly the properties below: per-tenant, first-writer-
-- wins, and expiring.

CREATE TYPE "idempotency_status" AS ENUM ('in_progress', 'completed');

-- The retention window, as a function rather than a literal.
--
-- Named here so a reader asking "how long is a key good for" finds one answer
-- instead of the DEFAULT below and the sweep's WHERE clause and a hope that they
-- agree. Twenty-four hours covers a client's retry budget several times over and
-- comfortably contains Slack's own redelivery window, so the same number serves
-- both consumers and there is no second knob.
CREATE FUNCTION idempotency_retention() RETURNS interval
LANGUAGE sql IMMUTABLE AS $$
  SELECT INTERVAL '24 hours';
$$;

COMMENT ON FUNCTION idempotency_retention() IS
  'How long an IdempotencyRecord is honoured. One definition shared by the insert default and the expiry sweep.';

CREATE TABLE "idempotency_record" (
    "id" UUID NOT NULL,

    -- Defaulted from the armed context, as on `audit_log` and `job`. A record is
    -- always written from inside the transaction of the request it guards, so
    -- the tenant is already established; naming it again at the insert site
    -- could only introduce a disagreement.
    "tenant_id" UUID NOT NULL DEFAULT NULLIF(current_setting('app.current_tenant', true), '')::uuid,

    -- Which *kind* of thing is being deduplicated. Free text, and deliberately
    -- so: an HTTP caller's scope is the request line it sent, an inbound adapter's
    -- is a name it chooses (`slack:event`). A closed vocabulary here would make
    -- the next integration a migration in three ports for no invariant gained —
    -- nothing branches on this value, it only partitions the key space.
    "scope" TEXT NOT NULL,

    -- The caller's key, verbatim. Opaque to us: we compare it and never parse it.
    "key" TEXT NOT NULL,

    -- A fingerprint of the request this key was first used for, so a key reused
    -- against a *different* request is refused rather than answered with the
    -- wrong cached response. That failure mode is the one worth spending a column
    -- on — a 409 tells a caller to wait, but a silently wrong replay tells them
    -- an operation succeeded that never ran.
    "request_hash" TEXT NOT NULL,

    "status" "idempotency_status" NOT NULL DEFAULT 'in_progress',

    -- Null while `in_progress`, and that nullability is the 409: a duplicate
    -- arriving before the original finished has nothing to be answered with, and
    -- must be told to retry rather than handed a half-formed result.
    "response_code" INTEGER,
    "response_body" JSONB,

    -- Who claimed the key, as attribution rather than as enforcement. The
    -- principal is already inside `scope`, which is what actually keeps two
    -- callers apart; these columns are here so an operator reading the table can
    -- see whose retry a record belongs to without parsing a composite string.
    "actor_kind" "actor_kind" NOT NULL DEFAULT current_actor_kind(),
    "actor_id" UUID DEFAULT current_actor_id(),

    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP + idempotency_retention(),

    CONSTRAINT "idempotency_record_pkey" PRIMARY KEY ("id"),

    -- The same shape `audit_log` uses: `system` is the one actor with no row to
    -- point at, and every other kind must name one.
    CONSTRAINT "idempotency_record_actor_id_matches_kind"
      CHECK (("actor_kind" = 'system') = ("actor_id" IS NULL))
);

ALTER TABLE "idempotency_record" ADD CONSTRAINT "idempotency_record_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- The whole guarantee, in one line.
--
-- First-writer-wins is not a code path here; it is this index refusing the second
-- INSERT. That matters because the racing requests are in *separate*
-- transactions — they must be, since an in-flight claim has to be visible to a
-- duplicate before the original commits its work — so nothing in the application
-- is in a position to see the race, and the only arbiter that can is the one
-- holding the lock on the index page.
--
-- The principal is inside `scope` rather than beside it as a fourth column, so
-- that this index is the *only* thing that has to be right. A separate column
-- would be one that a future query could forget to filter on; folded into the
-- key, "a caller can only ever reach its own records" is not a rule anybody has
-- to remember.
CREATE UNIQUE INDEX "idempotency_record_tenant_scope_key_idx"
  ON "idempotency_record"("tenant_id", "scope", "key");

-- The sweep's index. It scans by expiry across a tenant and nothing else does.
CREATE INDEX "idempotency_record_expires_at_idx"
  ON "idempotency_record"("expires_at");

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
--
-- One policy, and the absent second one is worth explaining.
--
-- Tenant isolation is the usual clause, with no `NOT current_actor_is_contact()`
-- on it — unlike `job` or `service_token`. A Contact opening a Ticket from the
-- portal is making exactly the kind of side-effecting POST this table exists to
-- protect, so foreclosing the contact axis here would leave the customer-facing
-- write paths, the ones most likely to be retried over a flaky mobile
-- connection, as the only ones without the guarantee.
--
-- Letting Contacts in raises a hazard no other table here has, because this one
-- stores *response bodies*. Two Contacts in a tenant are isolated from each other
-- by row ownership on `ticket`, and that isolation would be worth nothing if one
-- of them could read back the cached 201 from the other's ticket creation by
-- guessing a key.
--
-- The answer is in the key rather than in a second policy: `scope` carries a
-- server-derived reference to the principal that claimed the record (`c:<id>`,
-- `u:<id>`, `w:<session>`, `s:<token>`) ahead of the request line. Two principals
-- therefore cannot produce the same scope, so they cannot address each other's
-- records at all — the isolation is a property of the row's identity, not of a
-- predicate that a future query might sidestep. Same shape as tenant isolation
-- itself: the discriminating value is established from the credential and never
-- read from input.
--
-- A restrictive `FOR SELECT` policy narrowing rows to `current_actor_*` was the
-- obvious alternative and is deliberately not here, because it would break the
-- case that needs the guarantee most. An anonymous widget visitor's first write
-- is made *before* they have a Contact — resolving one is what that request does
-- — so it is claimed under a `system` actor, and the retry a second later is
-- claimed under the Contact the first attempt created. Under an actor-matching
-- policy the retry could not see the record it was meant to replay, and would
-- open a second Ticket: precisely the duplicate this table exists to prevent.
-- The actor columns stay as attribution — who first claimed this key — and carry
-- no enforcement.

ALTER TABLE "idempotency_record" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "idempotency_record" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "idempotency_record"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid
  );

-- DELETE is granted and, unusually for this schema, actually used: the expiry
-- sweep is the write path, and retention is the reason the table stays small
-- enough for the unique index above to keep being cheap forever.
GRANT SELECT, INSERT, UPDATE, DELETE ON "idempotency_record" TO app_user;
