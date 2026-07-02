-- ---------------------------------------------------------------------------
-- Ticket linkage: the conversation chain, enforced below the application
-- ---------------------------------------------------------------------------
--
-- `closed` is hard-terminal, so a Contact replying to a closed Ticket gets a new
-- one with a fresh clock. The new Ticket has to stay connected to what came
-- before, or the customer's history is lost precisely at the moment they are
-- repeating themselves.
--
-- Two self-referencing pointers carry that, and no grouping entity above Ticket.
-- A `Conversation` row is what you would reach for if Tickets could join a
-- conversation *several* ways — agent-initiated merge, cross-channel identity
-- unification — and build ticket 18 ruled merge out of scope while the
-- Contact identity-merge seam is deliberately still open. A grouping entity now
-- would front-run that open decision rather than serve a settled one.
--
-- The split of enforcement mirrors the state machine's. *Creating* a spawned
-- Ticket is application logic, because it needs the channel the reply arrived on
-- and the reply's body, neither of which is on a row a trigger can see. The
-- *shape* of what gets written — that ancestry is derived rather than claimed,
-- that it can never be rewritten, that a chain holds at most one live Ticket —
-- is here, so it holds for the Spring and FastAPI ports, for the seed, and for a
-- psql session.

-- ---------------------------------------------------------------------------
-- The pointers
-- ---------------------------------------------------------------------------
--
-- `spawned_from_ticket_id` is exact ancestry: the closed Ticket whose reply
-- produced this one. NULL on an origin Ticket, which is most of them.
--
-- `root_ticket_id` is the chain's origin, denormalized. NULL on an origin
-- Ticket — "I am the root" stated by convention rather than by a self-pointing
-- row, which keeps the column honest about what it is for: it exists only so
-- that reading a whole conversation is a flat indexed lookup instead of a
-- `WITH RECURSIVE`. That portability is the entire justification for storing a
-- fact that is otherwise derivable, and it is why the column is denormalized
-- but never *written* by a caller: the trigger below derives it.
--
-- Both nullable, both NULL together, and the CHECK says so. Two columns that
-- disagree about whether a Ticket is an origin would be worse than one column.

ALTER TABLE "ticket" ADD COLUMN "spawned_from_ticket_id" UUID;
ALTER TABLE "ticket" ADD COLUMN "root_ticket_id" UUID;

ALTER TABLE "ticket" ADD CONSTRAINT "ticket_linkage_is_whole"
  CHECK (("spawned_from_ticket_id" IS NULL) = ("root_ticket_id" IS NULL));

-- Composite `(tenant_id, ...)` per ADR-0002, as every tenant-scoped reference
-- in this schema is. It matters as much here as anywhere: foreign keys are
-- checked with row-level security bypassed, so a plain `spawned_from_ticket_id
-- -> ticket(id)` would be satisfied by *any* tenant's Ticket, and the chain read
-- would then be a cross-tenant join waiting to be discovered.
--
-- `ON DELETE CASCADE` rather than `SET NULL`, and it is the same forced choice
-- `Ticket.assignee` records in reverse: a composite `SET NULL` would have to
-- null `tenant_id` too, which is `NOT NULL`. Cascade is also the honest rule —
-- a spawned Ticket whose parent was hard-deleted would have a `root_ticket_id`
-- pointing at nothing, and `ticket:delete` is already understood to take the
-- conversation with it.
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_tenant_id_spawned_from_ticket_id_fkey"
  FOREIGN KEY ("tenant_id", "spawned_from_ticket_id")
  REFERENCES "ticket"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ticket" ADD CONSTRAINT "ticket_tenant_id_root_ticket_id_fkey"
  FOREIGN KEY ("tenant_id", "root_ticket_id")
  REFERENCES "ticket"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- The chain read's index. A conversation is `WHERE id = $root OR root_ticket_id
-- = $root` — the origin by primary key, its descendants by this index — ordered
-- by `created_at`, which is the order the conversation happened in.
CREATE INDEX "ticket_tenant_id_root_ticket_id_created_at_idx"
  ON "ticket" ("tenant_id", "root_ticket_id", "created_at");

-- ---------------------------------------------------------------------------
-- The re-reply invariant: at most one live Ticket per conversation
-- ---------------------------------------------------------------------------
--
-- A chatty customer replying three times to a closed Ticket must not end up
-- with three Tickets. The application reads for a live one before it spawns —
-- but a read followed by a write is a race, and a burst of replies is exactly
-- the shape of traffic that loses it.
--
-- So the invariant is an index rather than a check in a handler. `COALESCE` is
-- what makes it chain-*wide* rather than merely descendant-wide: the origin
-- Ticket has a NULL `root_ticket_id`, so indexing the raw column would let an
-- open origin coexist with an open child. The expression names every Ticket by
-- its chain, origins included.
--
-- Partial on `state <> 'closed'`, because closed Tickets are the ones a chain
-- accumulates — the invariant is about live work, and a unique index over all
-- states would forbid a chain from having a history at all.
--
-- Two concurrent spawns therefore end with one Ticket and one 409, rather than
-- with a fan-out nobody notices until the queue has duplicates in it.
CREATE UNIQUE INDEX "ticket_one_live_per_chain"
  ON "ticket" ("tenant_id", (COALESCE("root_ticket_id", "id")))
  WHERE "state" <> 'closed';

-- ---------------------------------------------------------------------------
-- Derivation and immutability
-- ---------------------------------------------------------------------------
--
-- `root_ticket_id` is never accepted from a writer, only derived. A caller names
-- the parent — the one fact it actually knows — and the database works out the
-- root, so the denormalized column cannot disagree with the ancestry it
-- summarizes. Any value supplied is overwritten rather than validated: there is
-- no reading under which a writer's opinion about the root is worth having, and
-- refusing it instead would only invite call sites to compute it correctly.
--
-- The parent lookup runs under row-level security, like every other statement in
-- the transaction, so a Contact naming another Contact's Ticket as parent finds
-- nothing and is refused here. The composite foreign key would have accepted it:
-- the row genuinely exists in this tenant. That makes this raise a real guard
-- rather than a redundant one.
--
--   TK003 — a parent that this context cannot see
--   TK004 — an attempt to rewrite ancestry after creation
CREATE FUNCTION ticket_enforce_linkage() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_root uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."spawned_from_ticket_id" IS NULL THEN
      -- An origin Ticket. NULL rather than a self-pointer, and stamped here so
      -- that a writer cannot manufacture a Ticket that claims a root without a
      -- parent to justify it.
      NEW."root_ticket_id" := NULL;

      RETURN NEW;
    END IF;

    -- `FOUND` rather than a NULL test on `parent_root`, because the parent's
    -- own root is legitimately NULL whenever the parent is itself the origin —
    -- which is the common case. Testing the value would read "no such parent"
    -- for every first spawn in a conversation.
    SELECT t."root_ticket_id"
      INTO parent_root
      FROM "ticket" t
     WHERE t."tenant_id" = NEW."tenant_id"
       AND t."id" = NEW."spawned_from_ticket_id";

    IF NOT FOUND THEN
      RAISE EXCEPTION 'ticket: no visible parent % to spawn from', NEW."spawned_from_ticket_id"
        USING ERRCODE = 'TK003',
              HINT = 'A spawned Ticket names a parent this context can read. Another Contact''s Ticket satisfies the foreign key but is not visible here.';
    END IF;

    -- The parent's root, or the parent itself when the parent *is* the root.
    -- One `COALESCE` is the whole of the chain arithmetic, and it is here rather
    -- than in three ports.
    NEW."root_ticket_id" := COALESCE(parent_root, NEW."spawned_from_ticket_id");

    RETURN NEW;
  END IF;

  -- UPDATE. Ancestry is a fact about how a Ticket came to exist, so there is no
  -- legitimate edit to it — the same append-only spirit the audit log has,
  -- applied to two columns rather than a table. Enforced rather than merely
  -- unimplemented, because "no code path writes this" is a claim about one port.
  IF NEW."spawned_from_ticket_id" IS DISTINCT FROM OLD."spawned_from_ticket_id"
     OR NEW."root_ticket_id" IS DISTINCT FROM OLD."root_ticket_id" THEN
    RAISE EXCEPTION 'ticket %: linkage is set at creation and immutable', OLD."id"
      USING ERRCODE = 'TK004',
            HINT = 'A conversation''s ancestry cannot be rewritten. Reply handling creates linked Tickets; nothing re-parents one.';
  END IF;

  RETURN NEW;
END;
$$;

-- Two triggers over one function, so the INSERT and UPDATE rules are readable
-- as one thing: they are the same rule — this pair of columns is written once,
-- by the database, from the parent.
--
-- The name sorts after `enforce_birth_state`, which is deliberate but not
-- load-bearing: the two BEFORE INSERT triggers are independent, and a Ticket
-- that is refused for not being born `open` should be refused whichever ran
-- first.
CREATE TRIGGER enforce_linkage_on_insert
  BEFORE INSERT ON "ticket"
  FOR EACH ROW EXECUTE FUNCTION ticket_enforce_linkage();

CREATE TRIGGER enforce_linkage_on_update
  BEFORE UPDATE ON "ticket"
  FOR EACH ROW EXECUTE FUNCTION ticket_enforce_linkage();

COMMENT ON COLUMN "ticket"."spawned_from_ticket_id" IS
  'The closed Ticket whose reply produced this one. NULL on an origin Ticket. Set at INSERT and immutable thereafter.';

COMMENT ON COLUMN "ticket"."root_ticket_id" IS
  'The conversation''s origin, denormalized so a whole chain is a flat indexed lookup rather than a recursive query. NULL on an origin Ticket. Derived by ticket_enforce_linkage(), never supplied.';
