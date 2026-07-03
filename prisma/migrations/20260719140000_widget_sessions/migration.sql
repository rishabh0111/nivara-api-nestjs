-- ---------------------------------------------------------------------------
-- Widget sessions: an anonymous handle, and the row that can kill it
-- ---------------------------------------------------------------------------
--
-- A widget session is a signed bearer token, and a bearer token has one
-- structural weakness: it is valid until it expires, so there is no answer to
-- "stop this one visitor" that does not also stop every other visitor. Rotating
-- the signing secret is the only token-only answer, and it signs out everybody.
--
-- The table below is the answer. One row per session id, consulted on every
-- widget request, so revocation is an UPDATE against one row and affects one
-- session. That is the whole reason this is stateful when the staff access
-- token deliberately is not — staff sessions are fifteen minutes and revocation
-- can be left to expiry, but an abusive anonymous visitor is a thing an
-- operator needs to be able to stop *now*.
--
-- The split between what the token carries and what this row carries is the
-- other design decision here. The token carries only what cannot change:
-- session id and tenant. Everything mutable — the resolved Contact, the expiry,
-- the revocation — lives here. So a Contact resolved mid-conversation is picked
-- up on the next request without re-minting anything, and a token in the wrong
-- hands cannot assert a Contact the server did not write.

-- ---------------------------------------------------------------------------
-- The per-tenant Origin allowlist
-- ---------------------------------------------------------------------------
--
-- The bootstrap endpoint is public and unauthenticated — it has to be, since a
-- visitor has no credential to present — so something other than a credential
-- has to bound who may mint a session, and for a browser widget that something
-- is the `Origin` header. It is not a secret and is not treated as one: a
-- non-browser caller can send whatever it likes. What the allowlist actually
-- buys is that the widget cannot be *lifted* — dropped onto an unrelated site
-- where real visitors' conversations would land in this tenant's queue.
--
-- Empty by default, and an empty list means the widget is off. A Tenant nobody
-- configured does not quietly serve sessions to any page that asks for one;
-- turning the widget on is a deliberate act with a row to point at.
ALTER TABLE "tenant"
  ADD COLUMN "widget_origins" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- ---------------------------------------------------------------------------
-- The session table
-- ---------------------------------------------------------------------------

CREATE TABLE "widget_session" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,

    -- Null until a Contact is actually needed. See the schema comment: this
    -- column being nullable *is* the "anonymous until it matters" guarantee,
    -- and it is also where a later identity merge lands.
    "contact_id" UUID,

    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),

    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "widget_session_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "widget_session" ADD CONSTRAINT "widget_session_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Composite per ADR-0002. A plain `contact_id -> contact(id)` reference would
-- be satisfied by *any* tenant's Contact, because foreign keys are checked with
-- row-level security bypassed — so the constraint could not tell a Meridian
-- session pointing at a Meridian Contact from one pointing at Sortwood's.
ALTER TABLE "widget_session" ADD CONSTRAINT "widget_session_tenant_id_contact_id_fkey"
  FOREIGN KEY ("tenant_id", "contact_id") REFERENCES "contact"("tenant_id", "id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "widget_session_tenant_id_expires_at_idx"
  ON "widget_session"("tenant_id", "expires_at");

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
--
-- The same two-clause shape every table on the contact axis has: the tenant
-- clause does all the work for staff and system, and a second clause narrows it
-- for a Contact to the rows that are its own. Written as "not a contact, OR the
-- contact owns this row" so that every other principal kind is unaffected by
-- construction rather than by enumeration.
--
-- Worth being explicit about which actor kind a widget request arms, because
-- there is no `widget` actor and there deliberately is not one: a widget
-- session that has resolved a Contact arms `contact`, so every policy already
-- written for the portal narrows a widget visitor identically. A widget visitor
-- is a Contact who has not said who they are, not a fourth kind of thing — and
-- adding a fourth actor kind would have meant revisiting every policy above to
-- decide what it means there.
--
-- Session *verification* runs under a `system` context, before any Contact is
-- known, which is why the tenant clause alone has to be enough to find the row.
ALTER TABLE "widget_session" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "widget_session" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "widget_session"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid
    AND (NOT current_actor_is_contact() OR "contact_id" = current_actor_uuid())
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid
    AND (NOT current_actor_is_contact() OR "contact_id" = current_actor_uuid())
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON "widget_session" TO app_user;
