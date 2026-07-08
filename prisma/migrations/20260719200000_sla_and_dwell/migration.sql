-- ---------------------------------------------------------------------------
-- SLA clocks, breach latches, and the activity stamp the dwell timers read
-- ---------------------------------------------------------------------------
--
-- The whole of ticket 15's arithmetic lives here rather than in a service,
-- because the load-bearing claim is that breach is a pure function of a single
-- Ticket row. That claim is only worth anything if it holds for every writer:
-- this API, the Spring and FastAPI ports, the sweep, and a psql session. An
-- accumulator maintained by application code would be an accumulator that is
-- correct for whichever port remembered to maintain it.
--
-- Three things are added, and they divide cleanly:
--
--   * `sla_target` — the per-priority matrix, one identical copy per tenant,
--     seeded by a trigger so no creation path can produce a tenant whose
--     Tickets are scored against nothing.
--   * Six columns on `ticket` — the clock state, the two sticky latches, and
--     the activity stamp. All maintained by triggers; none supplied by callers.
--   * The predicates the sweeps run, as SQL functions, so the sweep is a query
--     rather than a transcription of this file into TypeScript.

-- ---------------------------------------------------------------------------
-- The target matrix
-- ---------------------------------------------------------------------------
--
-- Rows rather than a constant table in code, for query symmetry: breach
-- evaluation is a join, so the targets have to be joinable, and analytics
-- (ticket 20) reads them the same way. Keyed on `(tenant, priority)` because
-- priority is the sole SLA input — state never selects a target, which is what
-- makes the deadline predictable from the priority alone.
--
-- Per-tenant rows carrying identical values is deliberate and not redundancy to
-- be normalised away. The values are fixed and not API-editable in v1, but the
-- *shape* is the one that admits a per-tenant policy later without a migration
-- that has to invent a tenant dimension after the fact. `sla:configure` already
-- exists in the permission catalog for that day.
CREATE TABLE "sla_target" (
    "tenant_id" UUID NOT NULL,
    "priority" "ticket_priority" NOT NULL,

    -- Milliseconds, as integers, rather than `interval`. Breach is compared
    -- against an elapsed figure that analytics also aggregates, and a number
    -- ports to all three stacks without each of them needing a mapping for a
    -- Postgres-specific type.
    "first_response_ms" BIGINT NOT NULL,
    "resolution_ms" BIGINT NOT NULL,

    CONSTRAINT "sla_target_pkey" PRIMARY KEY ("tenant_id", "priority"),
    CONSTRAINT "sla_target_targets_positive"
      CHECK ("first_response_ms" > 0 AND "resolution_ms" > 0)
);

ALTER TABLE "sla_target" ADD CONSTRAINT "sla_target_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "sla_target" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sla_target" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "sla_target"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- No INSERT, UPDATE or DELETE. The matrix is not API-editable in v1, and the
-- cheapest way to say so is to withhold the privilege rather than to rely on the
-- absence of a controller — which is a claim about one port. The seeding trigger
-- below runs as the table's owner during tenant creation, which app_user cannot
-- do anyway.
GRANT SELECT ON "sla_target" TO app_user;

-- The canonical matrix, in milliseconds:
--
--   urgent  first-response  1h    resolution    8h
--   high                    2h                 24h
--   normal                  8h                 72h
--   low                    24h                120h
--
-- Seeded by a trigger on tenant creation rather than by the seed script, so that
-- a tenant created by a test, a migration, or a future provisioning endpoint
-- gets the same four rows. A tenant without targets would have Tickets that can
-- never breach — a silent failure, and exactly the kind that survives review.
CREATE FUNCTION sla_seed_targets() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO "sla_target" ("tenant_id", "priority", "first_response_ms", "resolution_ms")
  VALUES
    (NEW."id", 'urgent',  3600000,   28800000),
    (NEW."id", 'high',    7200000,   86400000),
    (NEW."id", 'normal',  28800000, 259200000),
    (NEW."id", 'low',    86400000,  432000000);

  RETURN NEW;
END;
$$;

CREATE TRIGGER seed_sla_targets
  AFTER INSERT ON "tenant"
  FOR EACH ROW EXECUTE FUNCTION sla_seed_targets();

-- Tenants that already exist. The trigger only fires forward.
INSERT INTO "sla_target" ("tenant_id", "priority", "first_response_ms", "resolution_ms")
SELECT t."id", m."priority", m."first_response_ms", m."resolution_ms"
  FROM "tenant" t
 CROSS JOIN (VALUES
    ('urgent'::"ticket_priority",  3600000::bigint,   28800000::bigint),
    ('high'::"ticket_priority",    7200000::bigint,   86400000::bigint),
    ('normal'::"ticket_priority", 28800000::bigint,  259200000::bigint),
    ('low'::"ticket_priority",    86400000::bigint,  432000000::bigint)
 ) AS m("priority", "first_response_ms", "resolution_ms");

-- ---------------------------------------------------------------------------
-- The clock state on the Ticket
-- ---------------------------------------------------------------------------

ALTER TABLE "ticket"
  -- Set once, by the Message trigger below, and never overwritten. Its
  -- existence is what makes first-response duration pure arithmetic for
  -- analytics instead of a scan of the thread.
  ADD COLUMN "first_response_at" TIMESTAMPTZ(3),

  -- The materialized pause accumulator. `sla_paused_ms` is the closed
  -- intervals; `sla_pause_started_at` is the open one, non-null exactly while
  -- the Ticket sits in a clock-stopping state.
  --
  -- Together they make `active_elapsed` a single-row read, which is what the
  -- sweep and the analytics aggregate both need. Deriving it from the audit log
  -- instead would mean replaying a Ticket's history on every evaluation.
  ADD COLUMN "sla_paused_ms" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "sla_pause_started_at" TIMESTAMPTZ(3),

  -- The two sticky latches. Written once, never cleared — a late reply does not
  -- un-breach, and neither does a reopen. They are simultaneously the record
  -- analytics counts and the fire-once guard the escalation rests on, which is
  -- why there is no separate "escalated" flag: one column cannot disagree with
  -- itself about whether the notification went out.
  ADD COLUMN "first_response_breached_at" TIMESTAMPTZ(3),
  ADD COLUMN "resolution_breached_at" TIMESTAMPTZ(3),

  -- When something last happened on this Ticket, for the dwell timers alone.
  --
  -- Separate from `updated_at`, which is Prisma's and moves only when a Ticket
  -- *column* is written — a customer's reply is activity and does not touch a
  -- single one of them. Bumping `updated_at` from a trigger instead would have
  -- silently rewritten the meaning of the `updatedAt` sort on the queue list,
  -- so the new fact gets a new column rather than an old one quietly redefined.
  ADD COLUMN "last_activity_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Existing Tickets sitting in a clock-stopping state have an open pause
-- interval that nothing opened. Anchor it at the Ticket's last update — the best
-- available approximation of when it entered the state, and never later than the
-- truth, so the backfill cannot manufacture pause time that was not earned.
UPDATE "ticket"
   SET "sla_pause_started_at" = "updated_at",
       "last_activity_at" = "updated_at"
 WHERE "state" IN ('pending', 'resolved', 'closed');

UPDATE "ticket" SET "last_activity_at" = "updated_at"
 WHERE "state" NOT IN ('pending', 'resolved', 'closed');

-- The sweep scans. Both are `WHERE`-shaped exactly like the queries below:
-- unlatched rows in a state that can still breach, and dwelling rows past their
-- window. Partial, because the interesting set is a shrinking minority of a
-- growing table — a Ticket that has already breached or already closed is never
-- looked at again.
CREATE INDEX "ticket_sla_unlatched_idx"
  ON "ticket"("tenant_id", "created_at")
  WHERE "first_response_breached_at" IS NULL OR "resolution_breached_at" IS NULL;

CREATE INDEX "ticket_dwell_idx"
  ON "ticket"("tenant_id", "state", "last_activity_at")
  WHERE "state" IN ('pending', 'resolved');

-- ---------------------------------------------------------------------------
-- Elapsed time: two definitions, because there are two clocks
-- ---------------------------------------------------------------------------
--
-- The single most important thing in this file is that these are *different*
-- functions and which timer uses which. Both are named here rather than inlined
-- into the sweep's query, so the distinction is a schema fact the ports inherit
-- rather than a subtlety living in one service's SQL string.
--
-- First response is plain wall-clock and **does not pause**. That is not an
-- omission: reaching `pending` with no agent message means nobody has answered
-- yet, and we still owe a real answer — so a clock that stopped there would let
-- a team discharge its response promise by moving the Ticket rather than by
-- replying to it. In the ordinary case reaching `pending` coincides with an
-- agent message that already satisfied the clock, so this rule costs nothing;
-- it bites exactly in the case it is meant to.
CREATE FUNCTION ticket_sla_wall_elapsed_ms(
  created_at timestamptz,
  at timestamptz
) RETURNS bigint
LANGUAGE sql IMMUTABLE AS $$
  SELECT GREATEST(0, (EXTRACT(EPOCH FROM (at - created_at)) * 1000)::bigint);
$$;

COMMENT ON FUNCTION ticket_sla_wall_elapsed_ms(timestamptz, timestamptz) IS
  'Wall-clock milliseconds since creation, with no pause deduction. The first-response clock, which never pauses.';

-- The one definition of "how long has this customer been waiting" *against the
-- resolution promise*, as a function, so the sweep, a live read, and analytics
-- cannot each hold a slightly different copy of it.
--
-- Anchored at creation and reduced by accrued pause, which is what makes reopen
-- a resume rather than a reset: the resolved interval is closed and *added to*
-- the accumulator when the Ticket leaves `resolved`, so the clock picks up
-- exactly where it stopped. A ticket resolved at six hours and reopened does not
-- get a fresh budget, which is the property that stops reopen being a way to
-- launder elapsed time.
--
-- `GREATEST(0, …)` because clock skew and a backdated fixture should produce a
-- young Ticket, not a negative one that compares as "breached" against every
-- target at once.
CREATE FUNCTION ticket_sla_active_elapsed_ms(
  created_at timestamptz,
  paused_ms bigint,
  pause_started_at timestamptz,
  at timestamptz
) RETURNS bigint
LANGUAGE sql IMMUTABLE AS $$
  SELECT GREATEST(0,
    (EXTRACT(EPOCH FROM (at - created_at)) * 1000)::bigint
    - paused_ms
    - CASE
        WHEN pause_started_at IS NULL THEN 0
        ELSE (EXTRACT(EPOCH FROM (at - pause_started_at)) * 1000)::bigint
      END
  );
$$;

COMMENT ON FUNCTION ticket_sla_active_elapsed_ms(timestamptz, bigint, timestamptz, timestamptz) IS
  'Wall-clock milliseconds since creation, less accrued and in-progress pause. The resolution clock, which pauses in pending, resolved and closed.';

-- ---------------------------------------------------------------------------
-- Maintaining the clock: the state-machine trigger, extended
-- ---------------------------------------------------------------------------
--
-- Replaced rather than joined by a second trigger, because the pause accumulator
-- is a function of the same from-to pair this function already has in hand, and
-- two triggers on one table would leave their relative order as a thing a reader
-- has to work out from `pg_trigger` name ordering.
--
-- Everything above the transition check is new; the transition table, the
-- closed-Ticket lock and the three audit inserts are unchanged.
CREATE OR REPLACE FUNCTION ticket_enforce_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Set-once, enforced by coercion rather than by refusal.
  --
  -- These three columns are latches, and a latch that raises when written twice
  -- would make every idempotent retry — the sweep's whole design — into an error
  -- path that callers have to catch and ignore. Silently keeping the first value
  -- is the same guarantee with none of that: "never overwritten" becomes true of
  -- every writer through every port, including one that tries.
  IF OLD."first_response_at" IS NOT NULL THEN
    NEW."first_response_at" := OLD."first_response_at";
  END IF;

  IF OLD."first_response_breached_at" IS NOT NULL THEN
    NEW."first_response_breached_at" := OLD."first_response_breached_at";
  END IF;

  IF OLD."resolution_breached_at" IS NOT NULL THEN
    NEW."resolution_breached_at" := OLD."resolution_breached_at";
  END IF;

  -- The closed-Ticket lock, unchanged.
  IF OLD."state" = 'closed'
     AND (NEW."priority" IS DISTINCT FROM OLD."priority"
          OR NEW."assignee_id" IS DISTINCT FROM OLD."assignee_id") THEN
    RAISE EXCEPTION 'ticket %: a closed Ticket is locked', OLD."id"
      USING ERRCODE = 'TK002',
            HINT = 'Priority and assignee are immutable once closed. Nothing reopens a closed Ticket; a further reply spawns a new one.';
  END IF;

  IF NEW."state" IS DISTINCT FROM OLD."state" THEN
    IF NOT ticket_transition_is_legal(OLD."state", NEW."state") THEN
      RAISE EXCEPTION 'ticket %: % -> % is not a legal transition', OLD."id", OLD."state", NEW."state"
        USING ERRCODE = 'TK001',
              HINT = 'See ticket_transition_is_legal() for the table. The active triad interconverts freely; resolved reopens to open; closed is terminal.';
    END IF;

    -- The pause accumulator, maintained on exactly the edges that move it.
    --
    -- Close the open interval first, then open a new one if the destination also
    -- stops the clock. Written as two independent steps rather than a
    -- from-to matrix because that is what makes `pending -> resolved` — two
    -- stopping states in a row — come out right without being a special case.
    IF OLD."sla_pause_started_at" IS NOT NULL THEN
      NEW."sla_paused_ms" := OLD."sla_paused_ms"
        + GREATEST(0, (EXTRACT(EPOCH FROM (now() - OLD."sla_pause_started_at")) * 1000)::bigint);
      NEW."sla_pause_started_at" := NULL;
    END IF;

    -- `pending` stops the clock because time waiting on the customer is not the
    -- team's to answer for; `on_hold` deliberately does not, because an internal
    -- blocker is still the customer waiting and hiding it would make the metric
    -- flattering rather than useful. `resolved` and `closed` stop it because the
    -- work is done — and because that is what lets a reopen resume.
    IF NEW."state" IN ('pending', 'resolved', 'closed') THEN
      NEW."sla_pause_started_at" := now();
    END IF;

    INSERT INTO "audit_log" (
      "id", "tenant_id", "action", "target_kind", "target_id", "ticket_id",
      "from_value", "to_value"
    ) VALUES (
      gen_random_uuid(), NEW."tenant_id", 'ticket.transitioned', 'ticket',
      NEW."id", NEW."id", OLD."state"::text, NEW."state"::text
    );
  END IF;

  IF NEW."assignee_id" IS DISTINCT FROM OLD."assignee_id" THEN
    INSERT INTO "audit_log" (
      "id", "tenant_id", "action", "target_kind", "target_id", "ticket_id",
      "from_value", "to_value"
    ) VALUES (
      gen_random_uuid(), NEW."tenant_id", 'ticket.assigned', 'ticket',
      NEW."id", NEW."id", OLD."assignee_id"::text, NEW."assignee_id"::text
    );
  END IF;

  IF NEW."priority" IS DISTINCT FROM OLD."priority" THEN
    INSERT INTO "audit_log" (
      "id", "tenant_id", "action", "target_kind", "target_id", "ticket_id",
      "from_value", "to_value"
    ) VALUES (
      gen_random_uuid(), NEW."tenant_id", 'ticket.priority_changed', 'ticket',
      NEW."id", NEW."id", OLD."priority"::text, NEW."priority"::text
    );
  END IF;

  -- The three audited edits are exactly the three that count as activity for
  -- the dwell timers, which is not a coincidence: both lists answer "did a human
  -- do something to this Ticket". Latching a breach is conspicuously not on it —
  -- the sweep writing the latch must not reset the silence window it is
  -- measuring, or a breached Ticket would never dwell.
  IF NEW."state" IS DISTINCT FROM OLD."state"
     OR NEW."assignee_id" IS DISTINCT FROM OLD."assignee_id"
     OR NEW."priority" IS DISTINCT FROM OLD."priority" THEN
    NEW."last_activity_at" := now();
  END IF;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- First response, and conversation as activity
-- ---------------------------------------------------------------------------
--
-- On `message` and not on `note`, and that asymmetry is the entire rule: a first
-- response is something the customer can see. An internal Note is real work and
-- may well be the most useful thing anyone did, but it is not an answer, and a
-- team that could satisfy its response promise by writing to itself has a metric
-- that measures activity instead of responsiveness.
--
-- `user` and `service` authors only. A `service` author is the AI layer, which
-- genuinely did reply to the customer — deflection is a feature, not a way of
-- dodging the clock. A `contact` author is the customer, and their own message
-- cannot be the response to it.
--
-- Note that a Note *does* count as activity for the dwell timers below. The two
-- questions are different: "has anyone answered" and "has anyone touched this at
-- all", and a Ticket someone is actively working internally should not settle
-- itself out from under them.
CREATE FUNCTION ticket_observe_message() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "ticket"
     SET "last_activity_at" = NEW."created_at",
         "first_response_at" = CASE
           WHEN "first_response_at" IS NULL
            AND NEW."author_kind" IN ('user', 'service')
           THEN NEW."created_at"
           ELSE "first_response_at"
         END
   WHERE "tenant_id" = NEW."tenant_id"
     AND "id" = NEW."ticket_id";

  RETURN NULL;
END;
$$;

CREATE TRIGGER observe_message
  AFTER INSERT ON "message"
  FOR EACH ROW EXECUTE FUNCTION ticket_observe_message();

CREATE FUNCTION ticket_observe_note() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "ticket"
     SET "last_activity_at" = NEW."created_at"
   WHERE "tenant_id" = NEW."tenant_id"
     AND "id" = NEW."ticket_id";

  RETURN NULL;
END;
$$;

CREATE TRIGGER observe_note
  AFTER INSERT ON "note"
  FOR EACH ROW EXECUTE FUNCTION ticket_observe_note();

-- ---------------------------------------------------------------------------
-- The sweeper's cross-tenant view
-- ---------------------------------------------------------------------------
--
-- The sweeps need one thing no tenant context can give them: the list of
-- tenants to sweep. Everything after that runs under an ordinary tenant context
-- with a `system` actor, so the Tickets are read and written inside the same
-- isolation, the same policies and the same audit triggers as every other write
-- in the system.
--
-- That is why this is a *second* setting rather than a reuse of `app.scheduler`.
-- The drainer's context reads the queue and nothing else; widening it to cover
-- `tenant` would have enlarged a capability that already exists in order to
-- avoid naming a new one, and the two would then be indistinguishable in an
-- audit of what each can reach. Here the blast radius is stated exactly: a
-- sweeper context can enumerate tenants, and cannot read or write one row of
-- anything else — not a ticket, not a message, not a contact.
--
-- `FOR SELECT` and no `WITH CHECK`, because enumeration is all it is for.
CREATE POLICY sweeper_enumerate ON "tenant"
  FOR SELECT
  USING (current_setting('app.sweeper', true) = 'on');

-- ---------------------------------------------------------------------------
-- The dwell window
-- ---------------------------------------------------------------------------
--
-- Seven days, shared by both timers, as a function rather than a literal in two
-- queries. It is a product decision, and the sweep should not be where a reader
-- goes to find out what it currently is.
CREATE FUNCTION ticket_dwell_window() RETURNS interval
LANGUAGE sql IMMUTABLE AS $$ SELECT INTERVAL '7 days' $$;

COMMENT ON FUNCTION ticket_dwell_window() IS
  'The silence window after which a pending Ticket resolves itself and a resolved Ticket closes itself.';
