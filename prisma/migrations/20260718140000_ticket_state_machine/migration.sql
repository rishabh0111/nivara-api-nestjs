-- ---------------------------------------------------------------------------
-- The ticket state machine, enforced below the application
-- ---------------------------------------------------------------------------
--
-- A Ticket's lifecycle is a schema fact, not a convention this API observes.
-- The same Postgres database is meant to carry the Spring and FastAPI ports, a
-- scheduler moving Tickets on a timer, and a seed script — so a transition
-- table living in one service's code would be a guarantee that holds for
-- exactly one caller and reads as a guarantee for all of them.
--
-- Enforcement is split along the line of what SQL can actually know:
--
--   * From-to legality lives here, in a `BEFORE UPDATE` trigger. It needs only
--     the old row and the new one, both of which the database has.
--   * The role dimension — "only an admin may close" — lives in
--     `src/tickets/state-machine.ts`, because it needs the credential, which
--     the database does not have. Each port carries its own thin copy.
--
-- Auditing is not split at all. Every transition, assignment and priority
-- change emits its row from this same trigger, so "was that change logged"
-- stops being a question about the call site: there is no write path that
-- changes a Ticket and no audit row, because the log is written by the thing
-- that permits the change.

-- ---------------------------------------------------------------------------
-- The transition table
-- ---------------------------------------------------------------------------
--
-- Read it as three groups:
--
--   * The active triad `open`/`pending`/`on_hold` interconverts freely. These
--     are the states of live work, and moving between them is a description of
--     the situation rather than progress through a workflow — an agent should
--     never have to route through a third state to say what is true.
--   * `resolved` is soft-terminal: reachable from any active state, and
--     reopenable to `open`. Reopening is this transition and not a `reopened`
--     state, so nothing downstream has to special-case a near-duplicate of
--     `open`; "was this ever reopened" is an audit-log question.
--   * `closed` is hard-terminal, reachable only from `resolved`, and no pair
--     leads out of it. A Contact replying to a closed Ticket spawns a new
--     linked Ticket rather than reviving this one (ticket 10) — which is what
--     makes "terminal" true rather than aspirational.
--
-- A separate function rather than an inline predicate, so the table is
-- greppable, testable on its own, and callable by anything that wants to ask
-- before it writes.
CREATE FUNCTION ticket_transition_is_legal(
  from_state "ticket_state",
  to_state "ticket_state"
) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT (from_state, to_state) IN (
    -- The active triad, freely interconverting.
    ('open',     'pending'),
    ('open',     'on_hold'),
    ('pending',  'open'),
    ('pending',  'on_hold'),
    ('on_hold',  'open'),
    ('on_hold',  'pending'),

    -- Resolving, from anywhere live.
    ('open',     'resolved'),
    ('pending',  'resolved'),
    ('on_hold',  'resolved'),

    -- Reopening: a transition, not a state.
    ('resolved', 'open'),

    -- The one door to hard-terminal. Which role may walk through it is the
    -- application guard's business, not this table's.
    ('resolved', 'closed')
  );
$$;

-- ---------------------------------------------------------------------------
-- The trigger
-- ---------------------------------------------------------------------------
--
-- One trigger for all three audited edits rather than three, because they share
-- the load-bearing property: the check and the log entry are the same
-- statement's work, so neither can happen without the other.
--
-- Custom SQLSTATEs rather than the generic `P0001` a bare `RAISE` produces:
-- `TicketService` maps these to error codes in the published catalog, and
-- matching on a message string would make the wire contract depend on prose.
--
--   TK001 — an illegal from-to pair
--   TK002 — an edit to a locked (closed) Ticket
CREATE FUNCTION ticket_enforce_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- `closed` is not merely a terminal state, it is a locked record. Priority
  -- and assignment are orthogonal to state everywhere else — any urgency and
  -- any assignee are valid in any state — and this is the one place the two
  -- axes touch, which is why the check lives with the state machine rather
  -- than as lone state tests in two unrelated write paths.
  --
  -- Both columns, not just priority: reprioritising finished work and handing
  -- it to someone are the same false claim about a queue nobody is working, and
  -- locking one while leaving the other open would be an arbitrary half-rule
  -- that the next reader has to rediscover the reason for. `subject` is left
  -- alone deliberately — correcting a typo in a record is not a claim about
  -- live work.
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

    -- `from_value` / `to_value` as text, per the audit table's design: every
    -- audited change is an old→new pair, and typing the columns as any one
    -- domain enum would couple the log to all of them.
    --
    -- The actor is conspicuously absent. It is stamped by `audit_log`'s own
    -- BEFORE INSERT trigger from the armed context, so this insert cannot
    -- misattribute the change even if it wanted to — and an UPDATE arriving
    -- with no actor armed raises there rather than being logged as `system`.
    INSERT INTO "audit_log" (
      "id", "tenant_id", "action", "target_kind", "target_id", "ticket_id",
      "from_value", "to_value"
    ) VALUES (
      gen_random_uuid(), NEW."tenant_id", 'ticket.transitioned', 'ticket',
      NEW."id", NEW."id", OLD."state"::text, NEW."state"::text
    );
  END IF;

  -- Unassigning is a change worth recording, so this compares with IS DISTINCT
  -- FROM rather than `<>` — under `<>` every transition to or from NULL is NULL,
  -- which is not true, and the row that goes missing is exactly the one asking
  -- "who dropped this?".
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

  RETURN NEW;
END;
$$;

-- No `WHEN` clause, and no column list on `UPDATE OF`. Both would be
-- optimisations that quietly narrow the guarantee: `UPDATE OF state` does not
-- fire for a priority edit, and the closed-Ticket lock has to see those. The
-- trigger deciding for itself what changed is one place to read rather than a
-- rule split between the trigger definition and its body.
CREATE TRIGGER enforce_transition
  BEFORE UPDATE ON "ticket"
  FOR EACH ROW EXECUTE FUNCTION ticket_enforce_transition();

-- ---------------------------------------------------------------------------
-- The entry point
-- ---------------------------------------------------------------------------
--
-- Every Ticket is born `open`. The column already defaults to it, but a default
-- only decides what happens when nobody names a value — and a writer that names
-- one is precisely the case that matters. Without this, `INSERT INTO ticket
-- (..., state) VALUES (..., 'closed')` manufactures a Ticket that never entered
-- the machine: it skipped the transition table, skipped the role guard that
-- reserves closing, and left no `ticket.transitioned` row saying it ever
-- happened. That is the same hole the UPDATE trigger exists to close, reachable
-- one statement earlier.
--
-- "Born open" is also what makes the rest of the design honest. There is no
-- `new` state because untriaged is `assignee IS NULL`, and there is no
-- `reopened` state because reopening is a transition — both rest on every
-- Ticket starting from the same place, which is a claim this is what enforces.
--
-- The other two axes are unconstrained here on purpose. A Ticket may be born at
-- any priority and with an assignee already set: neither is a state-machine
-- fact, and *this* API declines to accept either at creation for its own
-- reasons (triage is an explicit act) rather than because the schema forbids it.
CREATE FUNCTION ticket_enforce_birth_state() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."state" <> 'open' THEN
    RAISE EXCEPTION 'ticket: a Ticket is born open, not %', NEW."state"
      USING ERRCODE = 'TK001',
            HINT = 'Insert the Ticket as open and transition it, so the move is checked and audited.';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER enforce_birth_state
  BEFORE INSERT ON "ticket"
  FOR EACH ROW EXECUTE FUNCTION ticket_enforce_birth_state();
