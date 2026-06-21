-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('agent', 'admin');

-- CreateTable
CREATE TABLE "tenant" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "user_role" NOT NULL DEFAULT 'agent',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "email" TEXT,
    "name" TEXT,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "contact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenant_slug_key" ON "tenant"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "user_tenant_id_email_key" ON "user"("tenant_id", "email");

-- CreateIndex
CREATE UNIQUE INDEX "contact_tenant_id_email_key" ON "contact"("tenant_id", "email");

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact" ADD CONSTRAINT "contact_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
--
-- Tenant isolation is a property of the database, not a discipline in
-- application code. A forgotten `where tenantId` in a service cannot leak
-- another tenant's rows, because Postgres never returns them in the first
-- place.
--
-- The predicate reads a transaction-local setting armed by `withTenant()`. Two
-- details make it fail closed:
--
--   * `current_setting(..., true)` returns NULL rather than raising when the
--     setting was never armed, and `NULLIF(..., '')` maps the empty string to
--     NULL too. A NULL predicate is not true, so a query issued outside any
--     tenant context matches nothing at all rather than erroring — and a query
--     that errored would be a far easier failure to paper over.
--
--   * `WITH CHECK` mirrors `USING`, so a tenant cannot write a row it would not
--     be able to read back. Without it, `INSERT` could plant a row under
--     another tenant's id.
--
-- `FORCE` subjects the table owner to its own policies. The runtime role is not
-- the owner, so this is belt and braces — but it is the belt that holds if the
-- application is ever misconfigured to connect as the owner.
--
-- Every tenant-scoped table added after this one repeats this block. A table
-- that arrives without it is reachable and unprotected.

ALTER TABLE "tenant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant" FORCE ROW LEVEL SECURITY;

-- `tenant` has no `tenant_id`; it *is* the tenant. Inside one tenant's context
-- exactly one row is visible — its own.
CREATE POLICY tenant_isolation ON "tenant"
  USING ("id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

ALTER TABLE "user" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "user" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "user"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

ALTER TABLE "contact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contact" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "contact"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- ---------------------------------------------------------------------------
-- Runtime role privileges
-- ---------------------------------------------------------------------------
--
-- `app_user` is created outside the migration — by the compose init SQL
-- locally, and by hand on Neon — because creating a login role means choosing a
-- password, which is deployment's business rather than the schema's. These
-- grants are deliberately unconditional: if the role is missing, the migration
-- fails loudly instead of leaving the application unable to read its own
-- tables.
--
-- DML only. `app_user` can never alter the schema, and it is not the owner, so
-- it can never escape its policies.

-- Granted table by table, and deliberately *not* via ALTER DEFAULT PRIVILEGES.
-- A blanket future grant would mean a later migration that forgot its policy
-- block produced a table `app_user` could read and write across every tenant,
-- with nothing to notice. Naming each table keeps the grant and the policy the
-- same edit: forget the grant and the first query fails loudly; forget the
-- policy and there is no grant for it to escape through.
GRANT SELECT, INSERT, UPDATE, DELETE ON "tenant", "user", "contact" TO app_user;
