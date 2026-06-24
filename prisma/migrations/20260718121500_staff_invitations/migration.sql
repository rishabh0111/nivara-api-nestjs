-- CreateTable
CREATE TABLE "staff_invitation" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "invited_by_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_invitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "staff_invitation_user_id_key" ON "staff_invitation"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "staff_invitation_tenant_id_token_hash_key" ON "staff_invitation"("tenant_id", "token_hash");

-- AddForeignKey
ALTER TABLE "staff_invitation" ADD CONSTRAINT "staff_invitation_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_invitation" ADD CONSTRAINT "staff_invitation_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "staff_invitation" ADD CONSTRAINT "staff_invitation_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
--
-- Tenant-scoped, so it repeats the block the tenancy migration established.
-- Note what this policy does *not* do: it says nothing about roles. An
-- invitation is admin-only work, and that is the permission guard's answer to
-- give — RLS owns which rows exist for a tenant, never who may act on them.
-- The two layers stay disjoint, which is what keeps the policy portable.

ALTER TABLE "staff_invitation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "staff_invitation" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "staff_invitation"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Runtime role privileges
-- ---------------------------------------------------------------------------
--
-- Named explicitly, for the reason the tenancy migration gives: a blanket
-- future grant would let a later table reach `app_user` without a policy.

GRANT SELECT, INSERT, UPDATE, DELETE ON "staff_invitation" TO app_user;
