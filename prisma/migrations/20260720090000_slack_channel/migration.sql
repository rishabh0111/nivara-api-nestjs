-- ---------------------------------------------------------------------------
-- Slack channel: inbound ingestion and reply-back delivery
-- ---------------------------------------------------------------------------
--
-- The first channel that is not this API's own surface, and the schema it needs
-- is four facts: which tenant a Slack workspace belongs to, which Slack person a
-- Contact is, where a Ticket is reachable in Slack, and whether a given reply has
-- already been posted.
--
-- Everything else the adapter needs already exists. Deduplicating provider
-- retries is `idempotency_record` under a scope of its own; the durable
-- ack-fast/process-later gap is `job`; the failure notification is `audit_log`
-- with the `integration.failed` action the audit catalog already reserved. That
-- is the payoff the primitives were built for, and it is why this migration adds
-- no queue, no retry state machine, and no second dedupe store.

-- ---------------------------------------------------------------------------
-- Which tenant a workspace is
-- ---------------------------------------------------------------------------
--
-- One distributed Slack app with one signing secret, installed per tenant. The
-- inbound `team_id` — authenticated by the signature check before it is read as
-- anything — selects the tenant through this table. The payload's own opinion
-- about who it belongs to is never consulted, because a payload cannot be asked
-- a question the signature has not already answered.
--
-- **This table deliberately holds no secret**, and the bot token lives beside it
-- in `slack_credential` instead. The reason is the lookup policy below: resolving
-- a workspace happens *before* any tenant is known — it is what establishes the
-- tenant — so the read cannot run under tenant isolation, and a policy narrows
-- rows without narrowing columns. A credential on this row would therefore be
-- readable cross-tenant by anything holding that context, bounded only by the
-- discipline of one `SELECT` list.
--
-- The same argument the `job.payload` convention makes: what crosses the tenant
-- boundary is routing information and nothing a tenant would mind another seeing.

CREATE TABLE "slack_installation" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,

    -- Slack's identifier for the workspace, and the lookup key. Globally unique
    -- rather than per tenant: one workspace belongs to one tenant, and a
    -- workspace that resolved to two would make the tenant of an inbound event
    -- ambiguous — which is the one thing this table exists to make certain.
    "team_id" TEXT NOT NULL,

    -- Who Slack thinks the bot is. Read to recognise the adapter's own postings
    -- on the way back in, so a reply this system delivered is not ingested as a
    -- new customer message. Without it the reply-back path is an echo loop.
    "bot_user_id" TEXT NOT NULL,

    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "slack_installation_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "slack_installation" ADD CONSTRAINT "slack_installation_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX "slack_installation_team_id_key"
  ON "slack_installation"("team_id");

-- The composite foreign-key target, as on `contact`, `user` and `ticket`.
-- Redundant as a uniqueness claim — `id` is already unique — and present only so
-- `slack_credential` can reference `(tenant_id, id)` per ADR-0002. Declared here
-- rather than beside that table because a referenced index has to exist before
-- the constraint that names it.
CREATE UNIQUE INDEX "slack_installation_tenant_id_id_key"
  ON "slack_installation"("tenant_id", "id");

-- ---------------------------------------------------------------------------
-- Row-level security on the installation table
-- ---------------------------------------------------------------------------
--
-- Two policies, and the second is the third narrow cross-tenant context in this
-- schema — after `app.scheduler` on `job` and `app.sweeper` on `tenant`. It is
-- granted on exactly the same terms and bounded the same three ways:
--
--   * `app.installations` is armed by one method, `withInstallationLookup()`,
--     which arms no tenant at all and is reachable only from the ingestion
--     route's tenant-resolution step.
--
--   * Only this table names the setting, so the context is not a skeleton key.
--     A ticket, a message, a contact stay as invisible under it as under no
--     context at all — asserted in `slack.int-spec.ts`, alongside the
--     `pg_policies` scan that catches a second table growing the same clause.
--
--   * SELECT only, and on a table that holds no secret. There is nothing here to
--     leak but the fact that a workspace is installed, and nothing to write.
--
-- The tenant clause carries `NOT current_actor_is_contact()`, matching `job`,
-- `note` and `service_token`: which workspaces a tenant has connected is
-- operator information, and a Contact enumerating them is a cheap thing to
-- foreclose.

ALTER TABLE "slack_installation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "slack_installation" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "slack_installation"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid
    AND NOT current_actor_is_contact()
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid
    AND NOT current_actor_is_contact()
  );

CREATE POLICY installation_lookup ON "slack_installation"
  FOR SELECT
  USING (current_setting('app.installations', true) = 'on');

GRANT SELECT, INSERT, UPDATE, DELETE ON "slack_installation" TO app_user;

-- ---------------------------------------------------------------------------
-- Which Slack person a Contact is
-- ---------------------------------------------------------------------------
--
-- Upserted per `(tenant_id, slack_user_id)`, so the same person's messages
-- accumulate on one Contact rather than spawning a stranger per message. The
-- Contact stays `verified = false`: Slack asserts the identity and we did not,
-- which is the same claim the widget path makes about an anonymous visitor.
--
-- Unique per tenant, not globally — a Slack account that raises support with two
-- tenants is two Contacts, exactly as the same human working for two tenants is
-- two Users (ADR-0001). NULLs are distinct in Postgres, so this constrains
-- Slack-linked Contacts without collapsing the many that have no Slack identity
-- at all.
--
-- No email is captured, and that is deliberate rather than pending: reading a
-- Slack user's email needs a scope this app does not ask for, and matching on it
-- would quietly resolve the cross-channel identity-merge seam that ADR-0001
-- leaves open.

ALTER TABLE "contact" ADD COLUMN "slack_user_id" TEXT;

CREATE UNIQUE INDEX "contact_tenant_id_slack_user_id_key"
  ON "contact"("tenant_id", "slack_user_id");

COMMENT ON COLUMN "contact"."slack_user_id" IS
  'The Slack account this Contact speaks from, when the conversation arrived that way. Unique per tenant; the upsert key for inbound ingestion.';

-- ---------------------------------------------------------------------------
-- Where a Ticket is reachable
-- ---------------------------------------------------------------------------
--
-- The reply path lives on the Ticket rather than on the Message, because it is a
-- property of the conversation: every customer-visible Message on this Ticket
-- goes back to the same Slack thread, and a copy per Message would be the same
-- fact written many times with the ability to disagree.
--
-- Both columns NULL together, and the CHECK says so. A channel with no thread is
-- not half a route — it is a Ticket that would deliver into a channel's top
-- level, which is precisely the reply-in-the-wrong-place failure the thread id
-- exists to prevent.

ALTER TABLE "ticket" ADD COLUMN "slack_channel_id" TEXT;
ALTER TABLE "ticket" ADD COLUMN "slack_thread_ts" TEXT;

ALTER TABLE "ticket" ADD CONSTRAINT "ticket_slack_route_is_whole"
  CHECK (("slack_channel_id" IS NULL) = ("slack_thread_ts" IS NULL));

-- The inbound thread lookup: a reply arrives naming a channel and a thread, and
-- has to find the Ticket the conversation is currently on.
--
-- Unique and partial on `state <> 'closed'`, mirroring `ticket_one_live_per_chain`
-- exactly — and the two are the same invariant seen from two directions. A chain
-- holds at most one live Ticket; a spawned Ticket inherits its parent's route
-- (see the trigger below); therefore a Slack thread has at most one live Ticket,
-- and the lookup is a single row rather than a newest-first guess. Making it
-- unique rather than merely indexed is what keeps that a fact instead of an
-- expectation.
CREATE UNIQUE INDEX "ticket_one_live_per_slack_thread"
  ON "ticket" ("tenant_id", "slack_channel_id", "slack_thread_ts")
  WHERE "state" <> 'closed' AND "slack_thread_ts" IS NOT NULL;

COMMENT ON COLUMN "ticket"."slack_channel_id" IS
  'The Slack channel this conversation arrived on, and where replies are delivered. NULL unless the conversation is reachable in Slack.';

COMMENT ON COLUMN "ticket"."slack_thread_ts" IS
  'The Slack thread this conversation is, as Slack''s stable thread identifier. Set at INSERT — inherited from the parent on a spawn — and immutable thereafter.';

-- ---------------------------------------------------------------------------
-- Inheritance and immutability of the route
-- ---------------------------------------------------------------------------
--
-- `ticket_enforce_linkage()` grows a third responsibility, and it belongs to it
-- rather than to a trigger of its own: the reply route is inherited from the
-- parent by exactly the argument `root_ticket_id` is. A customer whose reply to a
-- closed Ticket spawns a new one is still in the same Slack thread, and an agent
-- answering the spawned Ticket must reach them there. Deriving it here means no
-- call site — in this port or in the Spring and FastAPI ports — can spawn a
-- Ticket that is silently unreachable.
--
-- A supplied value on a spawn is overwritten rather than refused, for the reason
-- the root is: there is no reading under which a writer's opinion about where the
-- parent's conversation lives is worth having.
--
--   TK005 — an attempt to re-route a conversation after creation
CREATE OR REPLACE FUNCTION ticket_enforce_linkage() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  parent_root uuid;
  parent_channel text;
  parent_thread text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."spawned_from_ticket_id" IS NULL THEN
      -- An origin Ticket. NULL rather than a self-pointer, and stamped here so
      -- that a writer cannot manufacture a Ticket that claims a root without a
      -- parent to justify it.
      --
      -- Its Slack route, by contrast, is left exactly as supplied: an origin
      -- Ticket is the one that genuinely knows where it came from, because the
      -- ingestion handler read it off a verified event.
      NEW."root_ticket_id" := NULL;

      RETURN NEW;
    END IF;

    -- `FOUND` rather than a NULL test on `parent_root`, because the parent's
    -- own root is legitimately NULL whenever the parent is itself the origin —
    -- which is the common case. Testing the value would read "no such parent"
    -- for every first spawn in a conversation.
    SELECT t."root_ticket_id", t."slack_channel_id", t."slack_thread_ts"
      INTO parent_root, parent_channel, parent_thread
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

    -- The conversation continues where it was already reachable. Copied whether
    -- or not the parent had a route, so a spawn from a portal Ticket is left
    -- unreachable rather than inheriting a stale one from somewhere else.
    NEW."slack_channel_id" := parent_channel;
    NEW."slack_thread_ts" := parent_thread;

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

  -- The route is immutable for a sharper reason than ancestry is. Editing it
  -- would redirect every future reply on a live conversation to a thread the
  -- customer is not reading, and the customer would have no way to notice: the
  -- replies would look delivered. A moved conversation is a new Ticket, not an
  -- edited column.
  IF NEW."slack_channel_id" IS DISTINCT FROM OLD."slack_channel_id"
     OR NEW."slack_thread_ts" IS DISTINCT FROM OLD."slack_thread_ts" THEN
    RAISE EXCEPTION 'ticket %: the reply route is set at creation and immutable', OLD."id"
      USING ERRCODE = 'TK005',
            HINT = 'A Ticket is reachable where its conversation started. Nothing re-points a live conversation at another thread.';
  END IF;

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- Whether a reply has already been posted
-- ---------------------------------------------------------------------------
--
-- The delivery record, and it is worth being exact about what it is *not*. It is
-- not a retry state machine: retry, backoff and giving up all live on `job`,
-- which already does them and does them the same way for every kind of externally
-- fallible work. A second copy here would be two schedules that can disagree
-- about whether a delivery is still owed.
--
-- What this table owns is the half `job` cannot: **at-most-once posting**. The
-- queue is at-least-once by construction — a process killed between posting to
-- Slack and settling its row leaves a job whose lease expires and is handed out
-- again — so without a record of what has already been posted, every crash is a
-- double-post into a customer's thread. The unique index below is that record,
-- and the handler's first act is to claim it.
--
--   `pending`   — owed, and the job that owes it is in flight or waiting
--   `delivered` — posted, with the provider's own message id kept as proof
--   `dead`      — the job exhausted its attempts; an operator's to look at, and
--                 already announced to the tenant's agents
--
-- `dead` is a state here rather than only on the job because this is where an
-- operator asking "did my reply reach the customer" looks, and answering that
-- from a `job` row would mean joining a queue to a message through a payload.

CREATE TYPE "outbound_delivery_status" AS ENUM ('pending', 'delivered', 'dead');

-- The composite foreign-key target ADR-0002 requires. `message` had no need of
-- one until something referenced it; it does now, and the reference is composite
-- for the reason every tenant-scoped reference is — foreign keys are checked with
-- row-level security bypassed, so a plain `message_id -> message(id)` would be
-- satisfied by another tenant's Message.
CREATE UNIQUE INDEX "message_tenant_id_id_key" ON "message"("tenant_id", "id");

CREATE TABLE "outbound_delivery" (
    "id" UUID NOT NULL,

    -- Defaulted from the armed context, as on `audit_log`, `job` and
    -- `idempotency_record`. A delivery is always recorded from inside the
    -- transaction that wrote the Message it delivers.
    "tenant_id" UUID NOT NULL DEFAULT NULLIF(current_setting('app.current_tenant', true), '')::uuid,

    -- Which adapter carries it. Text rather than the `ticket_source` enum, for
    -- the reason `job.kind` is text: adapters arrive with integrations, and a
    -- database enum would make adding one a migration in three ports. It is also
    -- the honest type — `portal` and `widget` are places a Ticket starts, not
    -- places a reply is delivered to, and the enum would admit both.
    "source" TEXT NOT NULL,

    "message_id" UUID NOT NULL,

    -- Where it goes, serialized by the adapter that understands it
    -- (`<channel>/<thread_ts>` for Slack). Opaque here: this table records that a
    -- destination was reached, and never parses what the destination means.
    "target" TEXT NOT NULL,

    "status" "outbound_delivery_status" NOT NULL DEFAULT 'pending',

    -- What the far end called it. Kept because it is the only evidence outside
    -- Slack that the post happened, and because it is what a future edit or
    -- delete of a delivered reply would need to name.
    "external_id" TEXT,

    -- How many times a handler has claimed this delivery, so an operator reading
    -- a `dead` row can tell a far end that refused once from one that refused
    -- five times.
    "attempts" INTEGER NOT NULL DEFAULT 0,

    -- The most recent failure, overwritten each attempt. History belongs to the
    -- audit trail; a delivery table accumulating error history would be a second,
    -- worse one — the same argument `job.last_error` makes.
    "last_error" TEXT,

    "delivered_at" TIMESTAMPTZ(3),

    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbound_delivery_pkey" PRIMARY KEY ("id"),

    -- `delivered` is the one state that must carry its evidence, and the one
    -- state that may. A row claiming delivery with no instant to point at is a
    -- claim nobody can check.
    CONSTRAINT "outbound_delivery_delivered_at_matches_status"
      CHECK (("status" = 'delivered') = ("delivered_at" IS NOT NULL))
);

ALTER TABLE "outbound_delivery" ADD CONSTRAINT "outbound_delivery_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "outbound_delivery" ADD CONSTRAINT "outbound_delivery_tenant_id_message_id_fkey"
  FOREIGN KEY ("tenant_id", "message_id") REFERENCES "message"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- The whole at-most-once guarantee, in one line.
--
-- "Retries never double-post" is not a code path; it is this index refusing the
-- second INSERT. That matters because the racing writers are not in one process
-- — two drainers whose leases overlapped, or one drainer and its own restarted
-- successor — so nothing in the application is in a position to see the race, and
-- the only arbiter that can is the one holding the lock on the index page.
--
-- Keyed on the *target* as well as the Message, because delivering one reply to
-- two places is a legitimate future (a thread and a DM, two channels) and would
-- be wrongly refused by a Message-only key. Two attempts at the same target are
-- the duplicate; two targets are two deliveries.
CREATE UNIQUE INDEX "outbound_delivery_tenant_message_target_key"
  ON "outbound_delivery"("tenant_id", "message_id", "target");

-- The operator read: one tenant's unfinished or failed deliveries, newest first.
CREATE INDEX "outbound_delivery_tenant_status_created_at_idx"
  ON "outbound_delivery"("tenant_id", "status", "created_at" DESC);

-- Row-level security, with the same `NOT current_actor_is_contact()` clause
-- `job` carries and for the same reason: a delivery record is operational, and a
-- customer enumerating which of a tenant's replies failed to reach them is a
-- thing to foreclose rather than to reason about later.
ALTER TABLE "outbound_delivery" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "outbound_delivery" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "outbound_delivery"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid
    AND NOT current_actor_is_contact()
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid
    AND NOT current_actor_is_contact()
  );

-- No DELETE. A delivery record is the answer to "did this reply reach the
-- customer", and that question keeps being asked after the fact — so unlike
-- `idempotency_record`, which is a bounded window with a sweep behind it, these
-- rows are as durable as the Messages they describe and are removed only by the
-- cascade that removes those.
GRANT SELECT, INSERT, UPDATE ON "outbound_delivery" TO app_user;

-- ---------------------------------------------------------------------------
-- The workspace's credential, kept away from the lookup
-- ---------------------------------------------------------------------------
--
-- A second table for one column, and the split is the whole point rather than an
-- accident of ordering.
--
-- `slack_installation` is readable under `app.installations`, a context armed
-- before any tenant is known — it is what *establishes* the tenant. A policy
-- narrows rows and cannot narrow columns, so a credential stored there would be
-- readable cross-tenant by whatever holds that context, bounded only by the
-- discipline of one `SELECT` list. That is exactly the kind of guarantee this
-- schema refuses to rest on discipline.
--
-- So the token lives here, under ordinary tenant isolation and nothing else. By
-- the time it is needed the tenant is known: resolution happened at ingest, and
-- delivery runs inside `withTenant()` under the tenant that owns the reply. The
-- read is therefore an ordinary tenant-scoped read, and no context in this system
-- can see another tenant's bot token at all.
--
-- One row per installation, which is what a distributed Slack app produces: each
-- tenant's OAuth install yields its own workspace-scoped `xoxb-` token, and a
-- single shared token would authenticate against exactly one workspace — so every
-- other tenant's replies would fail `invalid_auth` rather than reaching anybody.
-- `SLACK_BOT_TOKEN` in configuration remains the fallback for a single-workspace
-- development run, and is what the key-free first boot leaves absent.

CREATE TABLE "slack_credential" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,

    -- The installation this credential belongs to. One-to-one: a workspace has
    -- one bot identity, and two tokens for one workspace would make "which one is
    -- current" a question with no answer in the schema.
    "installation_id" UUID NOT NULL,

    -- The workspace-scoped bot token, as Slack issued it. Stored rather than
    -- hashed, unlike every other secret in this schema — and the asymmetry is
    -- forced rather than chosen. A refresh token, an invitation and a service
    -- token are all credentials *presented to us*, so a digest is enough to
    -- recognise one. This is a credential we present to somebody else, and a
    -- digest cannot be presented.
    "bot_access_token" TEXT NOT NULL,

    -- Who authorized the install. Provenance for a credential that acts on the
    -- tenant's behalf, on the same terms `service_token.created_by_id` records —
    -- and nullable only because the OAuth flow that would populate it does not
    -- exist yet, so a seeded or hand-planted installation has nobody to name.
    "installed_by_id" UUID,

    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "slack_credential_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "slack_credential" ADD CONSTRAINT "slack_credential_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Composite per ADR-0002, so a credential cannot be attached to another tenant's
-- installation — which would be the one arrangement that reintroduces exactly the
-- cross-tenant exposure this table was split out to prevent.
ALTER TABLE "slack_credential" ADD CONSTRAINT "slack_credential_tenant_id_installation_id_fkey"
  FOREIGN KEY ("tenant_id", "installation_id")
  REFERENCES "slack_installation"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "slack_credential" ADD CONSTRAINT "slack_credential_tenant_id_installed_by_id_fkey"
  FOREIGN KEY ("tenant_id", "installed_by_id") REFERENCES "user"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "slack_credential_installation_id_key"
  ON "slack_credential"("installation_id");

-- Tenant isolation and *no* lookup policy. The absence is the design: this table
-- is deliberately invisible to `app.installations`, which is the entire reason it
-- is a separate table.
ALTER TABLE "slack_credential" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "slack_credential" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "slack_credential"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid
    AND NOT current_actor_is_contact()
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid
    AND NOT current_actor_is_contact()
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON "slack_credential" TO app_user;

-- Composite uniqueness on `(tenant_id, installation_id)`, which the single-column
-- unique above already implies. Present because the ORM reads the composite
-- reference and needs a matching constraint to see the relation as one-to-one.
CREATE UNIQUE INDEX "slack_credential_tenant_id_installation_id_key"
  ON "slack_credential"("tenant_id", "installation_id");
