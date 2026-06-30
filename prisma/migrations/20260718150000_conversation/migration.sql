-- ---------------------------------------------------------------------------
-- Conversation: two tables, on purpose
-- ---------------------------------------------------------------------------
--
-- `message` is what a Contact can read. `note` is what only staff can read.
-- They are separate tables rather than one table with an `internal` flag, and
-- that is the whole design: a flag makes every customer-facing read a query
-- that has to remember a `WHERE internal = false`, and there will be several of
-- those reads — the portal thread, the widget transcript, an export, the AI
-- layer's context window. Each is one forgotten clause away from showing a
-- customer what an agent wrote about them.
--
-- With two tables there is no clause to forget. The customer-visible read names
-- `message`; a Note is not in it, and no bug in the service layer can put one
-- there. The cost is a near-duplicate table definition, paid once here, and it
-- buys a guarantee that holds for the Spring and FastAPI ports too.
--
-- Note also what does *not* happen here: neither table is wired into
-- `audit_log`. Conversation content is domain data, attributed on its own rows
-- by the author columns below. Copying it into the control-plane record would
-- drown the signal that table carries and would put customer-visible prose into
-- a table that is deliberately un-deletable. The state changes a message
-- *causes* — an auto-reopen, say — are audited; the message is not.

-- ---------------------------------------------------------------------------
-- The tables
-- ---------------------------------------------------------------------------

CREATE TABLE "message" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,

    "body" TEXT NOT NULL,

    -- Polymorphic author, and the same arrangement `audit_log` uses for its
    -- actor: the defaults exist so the columns are not required at the insert
    -- site, and the trigger below is what makes them un-forgeable. Attribution
    -- is a fact about who armed the transaction, not a claim the inserting code
    -- gets to make about itself.
    --
    -- `current_actor_kind()` raises when nothing is armed rather than
    -- defaulting to `system`, so a Message cannot be written by an
    -- unattributed caller at all. That matters more here than it looks: this
    -- column is what makes deflection — the share of Messages authored by
    -- `service` — computable, and a population of rows quietly labelled
    -- `system` would make that number a fiction.
    "author_kind" "actor_kind" NOT NULL DEFAULT current_actor_kind(),
    "author_id" UUID DEFAULT current_actor_id(),

    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_pkey" PRIMARY KEY ("id"),

    -- Exactly one actor kind has no row to point at, and the constraint says
    -- which. Written as an equivalence rather than two ORed branches so neither
    -- half can be relaxed without the other being reconsidered.
    CONSTRAINT "message_author_id_matches_kind"
      CHECK (("author_kind" = 'system') = ("author_id" IS NULL))
);

CREATE TABLE "note" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "ticket_id" UUID NOT NULL,

    "body" TEXT NOT NULL,

    -- Identical to `message`, deliberately — the two thread reads are then the
    -- same code with a different table name. Not narrowed to `user` even though
    -- a Contact authoring an agent-only entry is incoherent: the AI layer
    -- writes Notes under a `service` actor, and a Contact cannot hold
    -- `note:write` in the first place, so the exclusion is already enforced
    -- where authority is decided.
    "author_kind" "actor_kind" NOT NULL DEFAULT current_actor_kind(),
    "author_id" UUID DEFAULT current_actor_id(),

    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "note_pkey" PRIMARY KEY ("id"),

    CONSTRAINT "note_author_id_matches_kind"
      CHECK (("author_kind" = 'system') = ("author_id" IS NULL))
);

-- The only read either table has: one Ticket's thread, keyset-paginated.
-- `ticket_id` leads after the tenant because the query is always for one
-- Ticket, and the `(created_at, id)` tail is what makes the traversal servable.
-- Declared DESC to match the newest-first default; Postgres reads the same
-- index backwards for the ascending scan a thread rendering wants.
CREATE INDEX "message_tenant_id_ticket_id_created_at_id_idx"
  ON "message"("tenant_id", "ticket_id", "created_at" DESC, "id" DESC);

CREATE INDEX "note_tenant_id_ticket_id_created_at_id_idx"
  ON "note"("tenant_id", "ticket_id", "created_at" DESC, "id" DESC);

-- ---------------------------------------------------------------------------
-- References
-- ---------------------------------------------------------------------------
--
-- Composite `(tenant_id, ticket_id)` per ADR-0002: foreign keys are checked
-- with row-level security bypassed, so a plain `ticket_id -> ticket(id)`
-- reference would be satisfied by another tenant's Ticket — which is exactly
-- how a Note could come to hang off a Ticket its tenant cannot see.
--
-- `CASCADE`, unlike `audit_log`'s reference to the same table. A thread is part
-- of the Ticket rather than a record *about* it: an audit entry has meaning
-- after its subject is deleted, and a reply to a deleted Ticket does not.

ALTER TABLE "message" ADD CONSTRAINT "message_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "message" ADD CONSTRAINT "message_tenant_id_ticket_id_fkey"
  FOREIGN KEY ("tenant_id", "ticket_id") REFERENCES "ticket"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "note" ADD CONSTRAINT "note_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "note" ADD CONSTRAINT "note_tenant_id_ticket_id_fkey"
  FOREIGN KEY ("tenant_id", "ticket_id") REFERENCES "ticket"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Attribution: stamped, not supplied
-- ---------------------------------------------------------------------------
--
-- The column defaults fill the author in when an insert omits it. This trigger
-- overwrites it whichever way, so an insert that *does* name an author gets the
-- context's answer instead of its own. Without it, "who wrote this" would be a
-- string the writing code chose, and a Message could be attributed to a Contact
-- by whoever inserted it.
--
-- One function for both tables rather than two, because the columns are named
-- identically on both and a second copy is a second thing to change. It is
-- deliberately *not* shared with `audit_log_stamp_actor()`: that one writes
-- `actor_kind`/`actor_id`, and a single function covering both would have to
-- discover its column names at runtime.

CREATE FUNCTION conversation_stamp_author() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW."author_kind" := current_actor_kind();
  NEW."author_id" := current_actor_id();

  RETURN NEW;
END;
$$;

CREATE TRIGGER stamp_author
  BEFORE INSERT ON "message"
  FOR EACH ROW EXECUTE FUNCTION conversation_stamp_author();

CREATE TRIGGER stamp_author
  BEFORE INSERT ON "note"
  FOR EACH ROW EXECUTE FUNCTION conversation_stamp_author();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
--
-- The same block every tenant-scoped table repeats, verbatim and deliberately
-- un-abstracted — see the tenancy-spine migration for why each clause is there.
-- A table that arrives without it is reachable and unprotected.
--
-- Worth being explicit about what this does and does not do for `note`: the
-- policy makes a Note invisible to another *tenant*. It says nothing about
-- Contacts, because a Contact and a User of the same tenant share a tenant
-- context — the policies cannot tell them apart. What keeps Notes away from
-- Contacts is the separate table above and the `note:read` permission, not
-- this policy, and reading it as the guarantee would be a misplaced trust.

ALTER TABLE "message" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "message" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "message"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

ALTER TABLE "note" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "note" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "note"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- Named explicitly rather than via ALTER DEFAULT PRIVILEGES, for the reason the
-- first migration gives: the grant and the policy stay one edit.
--
-- UPDATE and DELETE are granted, unlike on `audit_log`. Neither has a write
-- path today — a Message is an utterance and a correction is another Message —
-- but redaction is a real requirement that will eventually arrive, and it
-- should arrive as a considered endpoint rather than as a migration that
-- re-grants a privilege this table had taken away. Immutability here is a
-- product decision; on `audit_log` it is a guarantee, and the grants say which
-- is which.
GRANT SELECT, INSERT, UPDATE, DELETE ON "message" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "note" TO app_user;
