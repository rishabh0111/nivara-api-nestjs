-- Staff authentication: a password on the User, and the refresh-token ledger.
--
-- `refresh_token` is a tenant-scoped table, so it repeats the policy block the
-- tenancy migration established — enabled, forced, isolated on `tenant_id`,
-- and granted to `app_user` by name. A tenant-scoped table that arrives
-- without that block is reachable and unprotected.

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "password_hash" TEXT;

-- CreateTable
CREATE TABLE "refresh_token" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "family_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "family_expires_at" TIMESTAMPTZ(3) NOT NULL,
    "rotated_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refresh_token_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "refresh_token_tenant_id_family_id_idx" ON "refresh_token"("tenant_id", "family_id");

-- CreateIndex
CREATE UNIQUE INDEX "refresh_token_tenant_id_token_hash_key" ON "refresh_token"("tenant_id", "token_hash");

-- AddForeignKey
ALTER TABLE "refresh_token" ADD CONSTRAINT "refresh_token_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refresh_token" ADD CONSTRAINT "refresh_token_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

ALTER TABLE "refresh_token" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "refresh_token" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "refresh_token"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Runtime role privileges
-- ---------------------------------------------------------------------------
--
-- Named explicitly, for the same reason the tenancy migration named its three:
-- a blanket future grant would let a later table reach `app_user` without a
-- policy to constrain it.

GRANT SELECT, INSERT, UPDATE, DELETE ON "refresh_token" TO app_user;
