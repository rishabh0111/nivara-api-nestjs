CREATE TYPE "ticket_source" AS ENUM ('portal', 'widget', 'slack');

-- CreateEnum
CREATE TYPE "ticket_state" AS ENUM ('open', 'pending', 'on_hold', 'resolved', 'closed');

-- CreateEnum
CREATE TYPE "ticket_priority" AS ENUM ('low', 'normal', 'high', 'urgent');

-- CreateTable
CREATE TABLE "ticket" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "subject" TEXT NOT NULL,
    "contact_id" UUID NOT NULL,
    "assignee_id" UUID,
    "state" "ticket_state" NOT NULL DEFAULT 'open',
    "priority" "ticket_priority" NOT NULL DEFAULT 'normal',
    "source" "ticket_source" NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "ticket_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ticket_tenant_id_created_at_id_idx" ON "ticket"("tenant_id", "created_at" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "ticket_tenant_id_state_created_at_idx" ON "ticket"("tenant_id", "state", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ticket_tenant_id_assignee_id_created_at_idx" ON "ticket"("tenant_id", "assignee_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "ticket_tenant_id_contact_id_idx" ON "ticket"("tenant_id", "contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "contact_tenant_id_id_key" ON "contact"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "user_tenant_id_id_key" ON "user"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_tenant_id_contact_id_fkey" FOREIGN KEY ("tenant_id", "contact_id") REFERENCES "contact"("tenant_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket" ADD CONSTRAINT "ticket_tenant_id_assignee_id_fkey" FOREIGN KEY ("tenant_id", "assignee_id") REFERENCES "user"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- A note on the two foreign keys above
-- ---------------------------------------------------------------------------
--
-- Both reference `(tenant_id, id)` rather than `id`, and that is a tenancy
-- control rather than a modelling preference: foreign keys are checked with
-- row-level security bypassed, so a plain reference is satisfied by any
-- tenant's row. ADR-0002 has the full argument and the rule it sets for every
-- tenant-scoped table after this one.
--
-- The `(tenant_id, id)` unique indexes on `contact` and `user` exist only to
-- be the targets of these references; `id` alone is already unique.

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------
--
-- The same block every tenant-scoped table repeats, verbatim and deliberately
-- un-abstracted — see the tenancy-spine migration for why each clause is
-- there. A table that arrives without it is reachable and unprotected.
--
-- This is what makes "another tenant's Ticket returns 404" structural rather
-- than a check the service has to remember: the row is not returned to be
-- checked in the first place.

ALTER TABLE "ticket" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ticket" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "ticket"
  USING ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenant_id" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- Named explicitly rather than via ALTER DEFAULT PRIVILEGES, for the reason the
-- first migration gives: the grant and the policy stay one edit.
GRANT SELECT, INSERT, UPDATE, DELETE ON "ticket" TO app_user;

