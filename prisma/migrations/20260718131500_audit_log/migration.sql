-- ---------------------------------------------------------------------------
-- The append-only audit log
-- ---------------------------------------------------------------------------
--
-- What makes this table trustworthy is not that the application is careful with
-- it. It is that the application *cannot* be careless with it: history cannot be
-- rewritten, and a row cannot be written without an attributed actor, because
-- both are refusals Postgres issues rather than checks TypeScript performs. That
-- matters twice over — a tamper-evidence guarantee enforced in application code
-- is only as good as the last call site, and this schema is meant to be ported
-- to Spring and FastAPI, which would each need their own copy of a convention.
--
-- Control-plane only. Message and Note *content* is never audited: conversation
-- is domain data, attributed on its own rows, and duplicating it here would
-- drown the signal this table exists to carry.

-- The kinds of thing that can act, mirroring `ACTOR_KINDS` in
-- `src/tenancy/tenant-context.ts`. Closed, because "who did this" with an
-- open-ended answer is not an answer.
CREATE TYPE "actor_kind" AS ENUM ('user', 'contact', 'service', 'system');

-- The closed catalog of audited events.
--
-- A catalog rather than an open envelope: a newly audited event is an honest
-- schema fact and should cost a migration, not a new string appearing in
-- production. Two grouping decisions are deliberate — `ticket.transitioned` is
-- one action rather than one per state pair, and `sla.breached` is one action
-- with `metadata.kind` distinguishing first-response from resolution, because
-- analytics reads the SLA latch columns rather than this table.
--
-- Reserved, and deliberately absent until it has a write path: `contact.merged`,
-- which lands with the Contact identity-merge seam.
CREATE TYPE "audit_action" AS ENUM (
  'ticket.created',
  'ticket.transitioned',
  'ticket.assigned',
  'ticket.priority_changed',
  'sla.breached',
  'token.minted',
  'token.revoked',
  'integration.failed'
);

-- ---------------------------------------------------------------------------
-- Reading the actor out of the armed context
-- ---------------------------------------------------------------------------
--
-- `withTenant()` arms `app.current_actor_kind` / `app.current_actor_id`
-- alongside the tenant, transaction-locally. These read them back.
--
-- The absent case raises rather than defaulting to `system`. That choice is the
-- point of the whole table: a write arriving outside an armed context is exactly
-- the unattributed mutation the log exists to catch, and quietly labelling it
-- `system` would launder it as legitimate. `system` is a claim some code makes
-- on purpose, never a residue of nobody having made one.

CREATE FUNCTION current_actor_kind() RETURNS "actor_kind"
LANGUAGE plpgsql STABLE AS $$
DECLARE
  raw text := NULLIF(current_setting('app.current_actor_kind', true), '');
BEGIN
  IF raw IS NULL THEN
    RAISE EXCEPTION 'audit_log: no actor in context'
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Reach the database through withTenant(), which arms app.current_actor_kind.';
  END IF;

  RETURN raw::"actor_kind";
END;
$$;

CREATE FUNCTION current_actor_id() RETURNS uuid
LANGUAGE plpgsql STABLE AS $$
DECLARE
  raw text := NULLIF(current_setting('app.current_actor_id', true), '');
BEGIN
  IF raw IS NULL THEN
    -- `system` is the one actor with no row to point at, so a missing id is
    -- correct there and a bug everywhere else.
    IF current_actor_kind() = 'system' THEN
      RETURN NULL;
    END IF;

    RAISE EXCEPTION 'audit_log: actor kind % has no id in context', current_actor_kind()
      USING ERRCODE = 'insufficient_privilege',
            HINT = 'Reach the database through withTenant(), which arms app.current_actor_id.';
  END IF;

  RETURN raw::uuid;
END;
$$;

-- ---------------------------------------------------------------------------
-- The table
-- ---------------------------------------------------------------------------

CREATE TABLE "audit_log" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL DEFAULT NULLIF(current_setting('app.current_tenant', true), '')::uuid,

    "action" "audit_action" NOT NULL,

    -- Polymorphic actor: never supplied by a caller, always stamped from the
    -- armed context by the trigger below. The defaults exist so the columns are
    -- not required at the insert site; the trigger is what makes them
    -- un-forgeable.
    "actor_kind" "actor_kind" NOT NULL DEFAULT current_actor_kind(),
    "actor_id" UUID DEFAULT current_actor_id(),

    -- Polymorphic target. `target_kind` is text rather than an enum on purpose:
    -- the *action* catalog is the closed vocabulary this table commits to, and
    -- closing the target set as well would mean a migration every time an
    -- existing action learned to point at a new kind of row.
    "target_kind" TEXT NOT NULL,
    "target_id" UUID NOT NULL,

    -- A real column rather than a read of `target_id`, because the per-ticket
    -- timeline is the hot query and most rows target something that merely
    -- *belongs* to a Ticket rather than the Ticket itself.
    "ticket_id" UUID,

    -- Plain text, not domain enums. Transitions, priority changes and
    -- assignments are all old→new pairs, and typing these as any one of those
    -- enums would couple the table to every enum in the schema. The `action`
    -- column says how to read them.
    "from_value" TEXT,
    "to_value" TEXT,

    -- The irregular tail: minted scopes, dead-letter target and error, the
    -- `sla.breached` kind. Everything that is real structure is a column above.
    "metadata" JSONB,

    -- Ties one request's cascade of rows together. Nullable and unset for now:
    -- there is no request-id in the pipeline yet, and a column that is always
    -- populated with a freshly invented value would tie nothing to anything.
    "correlation_id" UUID,

    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id"),

    -- Exactly one actor kind has no id, and the constraint says which. Written
    -- as an equivalence rather than two ORed branches so neither half can be
    -- relaxed without the other being reconsidered.
    CONSTRAINT "audit_log_actor_id_matches_kind"
      CHECK (("actor_kind" = 'system') = ("actor_id" IS NULL))
);

-- The composite foreign-key target on the referenced side, as `contact` and
-- `user` already carry. Redundant as a uniqueness claim — `id` is the primary
-- key — and present only so the reference below can be composite.
CREATE UNIQUE INDEX "ticket_tenant_id_id_key" ON "ticket"("tenant_id", "id");

-- The per-ticket timeline, which is the only read this table has. `ticket_id`
-- leads after the tenant because the query is always for one Ticket, and the
-- `(created_at, id)` tail is what makes the keyset traversal servable.
CREATE INDEX "audit_log_tenant_id_ticket_id_created_at_id_idx"
  ON "audit_log"("tenant_id", "ticket_id", "created_at" DESC, "id" DESC);

-- ---------------------------------------------------------------------------
-- The Tenant reference, and why it does not cascade
-- ---------------------------------------------------------------------------
--
-- Every other tenant-scoped table uses `ON DELETE CASCADE`. This one cannot:
-- a cascade is a DELETE, and DELETE on this table is refused, so the cascade and
-- the append-only trigger would be two declarations commanding opposite things.
-- Postgres resolves that by raising `audit_log is append-only` from inside a
-- `DELETE FROM tenant` — an error that names the wrong table and reads like a
-- bug in the log rather than the rule it actually is.
--
-- `RESTRICT` states the rule directly: a Tenant with history cannot be hard-
-- deleted, and the error says exactly that. This is a real constraint rather
-- than a technicality — "history is kept forever" and "a Tenant can be erased"
-- are incompatible, and this is where they meet. Nothing in this API deletes a
-- Tenant, and tenant offboarding is the same open question as the admin
-- hard-delete → soft-delete tombstone that staff authentication spun off; both want a
-- deliberate answer rather than a cascade that quietly shreds the audit trail.
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- The Ticket reference, and an amendment to ADR-0002
-- ---------------------------------------------------------------------------
--
-- Composite, per ADR-0002: a plain `ticket_id -> ticket(id)` reference is
-- checked with row-level security bypassed and would be satisfied by another
-- tenant's Ticket.
--
-- ADR-0002 records that `ON DELETE SET NULL` is therefore unavailable on these
-- references, because nulling the pair would have to null the `NOT NULL`
-- `tenant_id` too. That is true of the bare form, and it is why `ticket.assignee`
-- uses `RESTRICT` — but Postgres 15 added a column list to the clause, and the
-- narrowed form nulls only the column named. So this reference gets both
-- properties at once: it cannot point outside its tenant, and audit rows outlive
-- the Ticket they describe rather than preventing its deletion. Durable identity
-- survives in `target_kind`/`target_id`, which are never nulled.
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_ticket_id_fkey"
  FOREIGN KEY ("tenant_id", "ticket_id") REFERENCES "ticket"("tenant_id", "id")
  ON DELETE SET NULL ("ticket_id") ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Attribution: stamped, not supplied
-- ---------------------------------------------------------------------------
--
-- The column defaults already fill the actor in when an insert omits it. This
-- trigger overwrites it whichever way, so an insert that *does* name an actor
-- gets the context's answer rather than its own — attribution is a fact about
-- who armed the transaction, and no call site gets to assert it.

CREATE FUNCTION audit_log_stamp_actor() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW."actor_kind" := current_actor_kind();
  NEW."actor_id" := current_actor_id();

  RETURN NEW;
END;
$$;

CREATE TRIGGER stamp_actor
  BEFORE INSERT ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_stamp_actor();

-- ---------------------------------------------------------------------------
-- Append-only, three ways
-- ---------------------------------------------------------------------------
--
-- 1. The grant below withholds UPDATE and DELETE from the runtime role, so the
--    application cannot rewrite history even with a bug in it.
-- 2. The revokes withhold them from everyone else the same way.
-- 3. The triggers refuse regardless of grants — including for the table owner,
--    who can re-grant to itself, and which is the migration role.
--
-- The DELETE trigger is statement-level, and that is the load-bearing detail:
-- row-level security means a `DELETE` matching no visible rows would otherwise
-- succeed silently, reporting zero rows affected. An attempt to erase history
-- must be an error somebody sees, not a no-op.
--
-- The UPDATE trigger has to be row-level, because there is exactly one mutation
-- it must let through and recognising it means comparing the row to itself.
-- `ON DELETE SET NULL (ticket_id)` is implemented as an UPDATE issued by the
-- foreign key's internal trigger — which runs with grants bypassed, so this
-- trigger is the only thing standing in its way, and a blanket refusal here
-- makes Tickets undeletable rather than making history immutable.
--
-- Releasing a deleted subject is not rewriting history: nothing the log
-- *asserts* changes, and the row's durable identity lives in `target_kind` /
-- `target_id`, which this permits no change to. So the exception is written as
-- narrowly as it can be stated — `ticket_id` going from set to null, and every
-- other column identical — rather than as "updates to `ticket_id` are fine".

CREATE FUNCTION audit_log_no_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: DELETE is not permitted'
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'The record is not erasable. Retention is a matter of dropping a time partition, not of deleting rows.';
END;
$$;

CREATE TRIGGER no_delete
  BEFORE DELETE ON "audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_no_delete();

-- TRUNCATE is a separate event, and withholding the privilege is not enough:
-- the owner holds it inherently and can re-grant it, so without this the whole
-- log is one statement away from gone — the single most destructive thing that
-- could happen to it, and the one a `BEFORE DELETE` trigger does not see.
CREATE FUNCTION audit_log_no_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: TRUNCATE is not permitted'
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'The record is not erasable. Retention is a matter of dropping a time partition, not of emptying the table.';
END;
$$;

CREATE TRIGGER no_truncate
  BEFORE TRUNCATE ON "audit_log"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_no_truncate();

CREATE FUNCTION audit_log_no_update() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  -- `NEW` with the one permitted difference undone. If that leaves it identical
  -- to `OLD`, the difference was the only one.
  probe "audit_log"%ROWTYPE := NEW;
BEGIN
  -- Nesting is what distinguishes the foreign key releasing a deleted Ticket
  -- from a hand-written statement that merely looks like it. The referential
  -- action runs as an internal trigger on `ticket`, so this trigger fires
  -- *inside* it, at depth two; a direct `UPDATE audit_log SET ticket_id = NULL`
  -- reaches here at depth one, since this trigger is itself the first level.
  -- Hence `> 1` rather than `> 0` — the off-by-one is the whole check, and
  -- without it the exemption lets anyone holding UPDATE detach entries from
  -- their subject one at a time, which is quiet, plausible-looking tampering of
  -- exactly the kind this table exists to prevent.
  IF pg_trigger_depth() > 1
     AND OLD."ticket_id" IS NOT NULL
     AND NEW."ticket_id" IS NULL THEN
    probe."ticket_id" := OLD."ticket_id";

    IF probe IS NOT DISTINCT FROM OLD THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION 'audit_log is append-only: UPDATE is not permitted'
    USING ERRCODE = 'insufficient_privilege',
          HINT = 'The record is not editable. Correct it by appending to it.';
END;
$$;

CREATE TRIGGER no_update
  BEFORE UPDATE ON "audit_log"
  FOR EACH ROW EXECUTE FUNCTION audit_log_no_update();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
--
-- The same block every tenant-scoped table repeats, verbatim. Note it does not
-- carry the append-only guarantee — a `FOR ALL` policy permits UPDATE and DELETE
-- as far as *tenancy* is concerned, and the grant and the trigger above are what
-- refuse them. Keeping the policy identical to every other table's is worth more
-- than folding a second concern into it.

ALTER TABLE "audit_log" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_log" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "audit_log"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- SELECT and INSERT and nothing else. This is the portable half of the
-- append-only guarantee: it survives into the Spring and FastAPI ports without
-- either of them having to know it exists.
GRANT SELECT, INSERT ON "audit_log" TO app_user;
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_log" FROM app_user;
REVOKE UPDATE, DELETE, TRUNCATE ON "audit_log" FROM PUBLIC;
