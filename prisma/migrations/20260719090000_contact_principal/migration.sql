-- ---------------------------------------------------------------------------
-- The Contact principal: a second access axis, enforced below the application
-- ---------------------------------------------------------------------------
--
-- A Contact is not a weak agent. Staff authority is a set of named permissions
-- derived from a role; a Contact holds none of them and never will — the role
-- map has no `contact` arm, so every `@RequiresPermission` route refuses one at
-- the guard. That is the application half, and on its own it would be a rule
-- living in one port's guard layer.
--
-- This migration is the other half, and the one that ports. Row-level security
-- already answers "which tenant's rows exist for me". Here it learns to answer
-- "which of *this* tenant's rows exist for me", for the one principal kind whose
-- answer is narrower than the tenant: a Contact sees the Tickets it requested
-- and the Messages on them, and cannot see a Note at all.
--
-- The result is that a Contact's reach is bounded by two independent mechanisms
-- that would both have to fail together. A bug in a portal handler that forgot
-- to scope a query returns the Contact's own rows anyway, because the policy is
-- the predicate — and the same holds for the Spring and FastAPI ports, which
-- will not share a line of that handler.

-- ---------------------------------------------------------------------------
-- A portal credential
-- ---------------------------------------------------------------------------
--
-- Nullable, and usually null: a widget visitor becomes a Contact without ever
-- having a credential. A hash here is what lets a Contact sign into the portal.

ALTER TABLE "contact" ADD COLUMN "password_hash" TEXT;

-- ---------------------------------------------------------------------------
-- Sessions for two kinds of subject
-- ---------------------------------------------------------------------------
--
-- A portal session is the same mechanism as a staff session — rotation on every
-- use, family-wide eviction on replay, 30-day sliding inside a 90-day cap — so
-- it is the same table rather than a parallel one. Two tables would be two
-- copies of the replay logic, and the day they disagreed, one of them would be
-- the one that stopped detecting theft.
--
-- The subject is an exclusive arc: `user_id` or `contact_id`, never both and
-- never neither.

ALTER TABLE "refresh_token" ALTER COLUMN "user_id" DROP NOT NULL;
ALTER TABLE "refresh_token" ADD COLUMN "contact_id" UUID;

-- The arc, stated as an inequality of null-ness so neither half can be relaxed
-- without the other being reconsidered. A row with both set would be a session
-- belonging to two principals; a row with neither would be a session belonging
-- to nobody, and `classify()` would have no subject to return.
ALTER TABLE "refresh_token" ADD CONSTRAINT "refresh_token_subject_is_exclusive"
  CHECK (("user_id" IS NULL) <> ("contact_id" IS NULL));

-- Composite `(tenant_id, subject_id)` per ADR-0002, for both arcs.
--
-- The `user` arc was plain before this migration, and is replaced rather than
-- left alone. Foreign keys are checked with row-level security bypassed, so a
-- plain `user_id -> user(id)` reference is satisfied by *any* tenant's User —
-- meaning the constraint could not tell a session for Meridian's Ada from one
-- naming Sortwood's. Nothing writes such a row today, because both ids come off
-- one authenticated row; the point of ADR-0002 is that this should not depend on
-- that continuing to be true. Adding a correct constraint for the new arc while
-- leaving the old one weak would make the table's two halves disagree about
-- their own rule.
ALTER TABLE "refresh_token" DROP CONSTRAINT "refresh_token_user_id_fkey";

ALTER TABLE "refresh_token" ADD CONSTRAINT "refresh_token_tenant_id_user_id_fkey"
  FOREIGN KEY ("tenant_id", "user_id") REFERENCES "user"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "refresh_token" ADD CONSTRAINT "refresh_token_tenant_id_contact_id_fkey"
  FOREIGN KEY ("tenant_id", "contact_id") REFERENCES "contact"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- The contact axis in row-level security
-- ---------------------------------------------------------------------------
--
-- Every policy below reads the armed context through `current_setting(...,
-- true)` directly rather than through `current_actor_kind()`. That is
-- deliberate and load-bearing: the helper *raises* when nothing is armed, which
-- is right at an INSERT site — an unattributed audit row or Message should fail
-- loudly — and wrong in a policy predicate, where it would turn "this query
-- matched nothing" into a database error. The whole tenancy spine is built on
-- an unarmed query returning zero rows rather than erroring, because a query
-- that errors is one somebody papers over with a retry. A NULL predicate is not
-- true, so these read exactly as fail-closed as the tenant clause beside them.
--
-- The shape is the same in each: the tenant clause is unchanged and still does
-- all the work for staff, and a second clause narrows it for one actor kind.
-- Written as "not a contact, OR the contact owns this row" so that every other
-- principal — user, service, system — is unaffected by construction rather than
-- by enumeration. A principal kind added later is visible-by-default here, which
-- is the correct direction: a new kind that needs narrowing gets a policy of its
-- own and a test that says so, rather than silently inheriting a Contact's
-- restrictions.

CREATE OR REPLACE FUNCTION current_actor_is_contact() RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_actor_kind', true), '') = 'contact';
$$;

COMMENT ON FUNCTION current_actor_is_contact() IS
  'Whether the armed actor is a Contact. NULL-safe and non-raising, unlike current_actor_kind(): policies must fail closed by matching no rows, never by erroring.';

CREATE OR REPLACE FUNCTION current_actor_uuid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.current_actor_id', true), '')::uuid;
$$;

COMMENT ON FUNCTION current_actor_uuid() IS
  'The armed actor id, or NULL when none is armed. The non-raising counterpart to current_actor_id(), for use in policy predicates.';

-- A Contact sees the Tickets it requested, and no others.
--
-- `WITH CHECK` matters as much as `USING` here: it is what stops a Contact
-- opening a Ticket that names somebody else as its requester. Without it, the
-- portal's create path would be the only thing standing between a customer and
-- a Ticket filed in another customer's name.
DROP POLICY tenant_isolation ON "ticket";

CREATE POLICY tenant_isolation ON "ticket"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid
    AND (NOT current_actor_is_contact() OR "contact_id" = current_actor_uuid())
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid
    AND (NOT current_actor_is_contact() OR "contact_id" = current_actor_uuid())
  );

-- A Contact sees the Messages on its own Tickets.
--
-- The `EXISTS` re-derives ownership from `ticket` rather than trusting a column
-- on `message`, because there is no such column and there should not be: a
-- Message's audience is a fact about the Ticket it hangs off, and denormalizing
-- it here would create a second copy that a Ticket-level change could not
-- update. The subquery hits `ticket`'s primary key, and note that it is *not*
-- itself filtered by the ticket policy — policies do not recurse into
-- subqueries — so this clause states the ownership test in full rather than
-- leaning on the policy above.
DROP POLICY tenant_isolation ON "message";

CREATE POLICY tenant_isolation ON "message"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid
    AND (
      NOT current_actor_is_contact()
      OR EXISTS (
        SELECT 1 FROM "ticket" t
        WHERE t."tenant_id" = "message"."tenant_id"
          AND t."id" = "message"."ticket_id"
          AND t."contact_id" = current_actor_uuid()
      )
    )
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid
    AND (
      NOT current_actor_is_contact()
      OR EXISTS (
        SELECT 1 FROM "ticket" t
        WHERE t."tenant_id" = "message"."tenant_id"
          AND t."id" = "message"."ticket_id"
          AND t."contact_id" = current_actor_uuid()
      )
    )
  );

-- A Contact sees itself, and no other Contact.
--
-- Narrowed for the same reason the tables above are, and the stakes are higher
-- than they first look: this table holds every customer's email, name, and now
-- `password_hash`. Leaving it tenant-wide would mean a Contact's armed context
-- could read the tenant's entire customer list — a bug in one portal handler
-- away from being an endpoint that serves it.
--
-- `PortalAuthService.currentContact` filters by id in its `where` clause too.
-- That is not redundancy to be removed: the filter is what the query asks for,
-- and this is what happens when a query forgets to ask.
DROP POLICY tenant_isolation ON "contact";

CREATE POLICY tenant_isolation ON "contact"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid
    AND (NOT current_actor_is_contact() OR "id" = current_actor_uuid())
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid
    AND (NOT current_actor_is_contact() OR "id" = current_actor_uuid())
  );

-- A Contact sees audit entries for its own Tickets, and no others.
--
-- Without this clause a Contact's context could read the tenant's entire
-- history: who was assigned what, every priority change on every customer's
-- Ticket, and the tenant-configuration events that carry no `ticket_id` at all.
-- The ticket policy above narrows `ticket`; it says nothing about rows that
-- merely point at one.
--
-- Narrowed to own-Tickets rather than excluded outright, and the reason is
-- worth recording because "a Contact sees no audit row, ever" was the first
-- attempt and it broke opening a Ticket. `AuditService.record` inserts through
-- Prisma, which emits `INSERT ... RETURNING` — and `RETURNING` is a read, so it
-- is checked against `USING`, not just `WITH CHECK`. A policy that let a Contact
-- write a row it could not read back failed the insert itself, from inside the
-- transaction that was creating the Ticket. The narrowed form has no such
-- problem: the `ticket.created` row a Contact causes points at that Contact's
-- own Ticket, so it reads back cleanly.
--
-- A row with a NULL `ticket_id` — every tenant-configuration event — fails the
-- EXISTS and is therefore invisible to a Contact, which is the right answer:
-- token mints and SLA policy changes are nobody's business but the tenant's.
DROP POLICY tenant_isolation ON "audit_log";

CREATE POLICY tenant_isolation ON "audit_log"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid
    AND (
      NOT current_actor_is_contact()
      OR EXISTS (
        SELECT 1 FROM "ticket" t
        WHERE t."tenant_id" = "audit_log"."tenant_id"
          AND t."id" = "audit_log"."ticket_id"
          AND t."contact_id" = current_actor_uuid()
      )
    )
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid
    AND (
      NOT current_actor_is_contact()
      OR EXISTS (
        SELECT 1 FROM "ticket" t
        WHERE t."tenant_id" = "audit_log"."tenant_id"
          AND t."id" = "audit_log"."ticket_id"
          AND t."contact_id" = current_actor_uuid()
      )
    )
  );

-- A Contact sees no Note. Ever, on any Ticket, including its own.
--
-- This is the third independent statement of the same guarantee, and the
-- redundancy is the design. Notes live in a table the customer-visible read does
-- not name (ticket 08); `note:read` is not a permission any Contact can hold;
-- and now the rows are invisible to a Contact's context outright. Any one of the
-- three would do on a good day. Together they mean that exposing a Note takes a
-- new endpoint, a new grant, *and* a policy change — three deliberate acts, not
-- one forgotten `WHERE`.
DROP POLICY tenant_isolation ON "note";

CREATE POLICY tenant_isolation ON "note"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid
    AND NOT current_actor_is_contact()
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid
    AND NOT current_actor_is_contact()
  );
