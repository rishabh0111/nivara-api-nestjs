-- ---------------------------------------------------------------------------
-- Service tokens: the AI layer's authority, made explicit and revocable
-- ---------------------------------------------------------------------------
--
-- A machine credential that is a row rather than a signed claim set, and the
-- difference is the whole design. A staff access token is a JWT and deliberately
-- stateless: fifteen minutes is short enough that revocation can be left to
-- expiry. Neither half of that argument holds here. A service token has no
-- expiry — an integration that stops working every fifteen minutes is not an
-- integration — so expiry cannot stand in for revocation; and its scopes are
-- chosen per integration and widened over time, so a signed copy of them in the
-- caller's hands would be a version of the truth that outlives this table.
--
-- So the token carries nothing but a routing hint and a secret, and every
-- request reads this row. That per-request read is bought on purpose: it is what
-- makes "revocation takes effect on the very next request" true with no cache in
-- the path. TTL here would be revocation delay by another name.
--
-- Only the hash is stored, for the reason `refresh_token` and `staff_invitation`
-- store only a hash: reading this table must not yield a usable credential. A
-- database dump gives an attacker sha256 digests of 32-byte CSPRNG secrets,
-- which is nothing.

CREATE TABLE "service_token" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,

    "name" TEXT NOT NULL,

    -- sha256 of the whole presented value, tenant segment included. Covering
    -- the tenant segment is what stops it being edited: splicing another
    -- tenant's id in front of a real secret yields a value that hashes to
    -- nothing on file, rather than a lookup in a tenant the holder picked.
    "token_hash" TEXT NOT NULL,

    -- Permissions from the application's one authority catalog, shared with
    -- staff roles. Text rather than a Postgres enum: the catalog lives in the
    -- application and is read by three language ports, and mirroring it here
    -- would be a second vocabulary to keep in step — precisely the parallel
    -- namespace this feature exists to avoid. The un-grantable set is enforced
    -- at mint *and* re-subtracted on every read, so a row written around the
    -- mint path still confers nothing forbidden.
    "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],

    -- Stamped from the minting admin's credential, never from request input.
    "created_by_id" UUID NOT NULL,

    -- Set once, never cleared. See the schema comment: reinstating access
    -- should cost a new secret.
    "revoked_at" TIMESTAMPTZ(3),

    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_token_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "service_token" ADD CONSTRAINT "service_token_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Composite per ADR-0002. A plain `created_by_id -> "user"(id)` reference would
-- be satisfied by *any* tenant's User, because foreign keys are checked with
-- row-level security bypassed — so it could not tell a Meridian token minted by
-- a Meridian admin from one naming Sortwood's.
--
-- `ON DELETE RESTRICT`, where most references here cascade. The minting admin is
-- this row's provenance, and provenance that disappears when someone leaves is
-- not provenance. A tenant that wants the User gone revokes their tokens first.
ALTER TABLE "service_token" ADD CONSTRAINT "service_token_tenant_id_created_by_id_fkey"
  FOREIGN KEY ("tenant_id", "created_by_id") REFERENCES "user"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Global rather than per tenant, and that is deliberate. Verification looks a
-- presented token up by hash inside the tenant its own routing segment names;
-- a globally unique index means no two tenants can hold rows that one presented
-- value would match, so the lookup cannot become ambiguous even in principle.
CREATE UNIQUE INDEX "service_token_token_hash_key"
  ON "service_token"("token_hash");

CREATE INDEX "service_token_tenant_id_created_at_id_idx"
  ON "service_token"("tenant_id", "created_at" DESC, "id" DESC);

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
--
-- The tenant clause, plus `NOT current_actor_is_contact()` — the same shape
-- `note` carries, and for the same reason. Nothing in the customer-facing
-- surfaces reads this table and no grant a Contact can hold names it, so the
-- clause enforces nothing the authorization model does not already; it is here
-- because the cost is a boolean and the failure it forecloses is a customer
-- enumerating a tenant's machine credentials.
--
-- Note which actors this *does* admit: `service`, alongside `user` and `system`.
-- A service token arms the `service` kind and is therefore exempt from the
-- Contact axis exactly as staff are — the agent-equivalence the ticket
-- specifies, falling out of the clause rather than needing a case of its own.
-- That exemption is not authority to manage tokens: `token:manage` is
-- un-grantable to a machine, so no service token reaches the routes that read or
-- write this table.
--
-- Verification itself runs under a `system` context, before any principal
-- exists — which is why the tenant clause alone has to be enough to find the
-- row.
ALTER TABLE "service_token" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "service_token" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "service_token"
  USING (
    "tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid
    AND NOT current_actor_is_contact()
  )
  WITH CHECK (
    "tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid
    AND NOT current_actor_is_contact()
  );

-- DELETE is granted but has no write path, matching `refresh_token`: revocation
-- is an UPDATE setting `revoked_at`, because a deleted row would take the audit
-- trail's target with it and leave `token.revoked` pointing at nothing.
GRANT SELECT, INSERT, UPDATE, DELETE ON "service_token" TO app_user;
