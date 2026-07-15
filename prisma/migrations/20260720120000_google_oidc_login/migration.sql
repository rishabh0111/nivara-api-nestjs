-- Google OIDC sign-in: a second credential on the same User.
--
-- One column, and the shape of it is the whole decision. Google is an
-- authentication *method* onto an invite-provisioned User, not a second identity
-- system: there is no `google_user` table, no join, and no row a Google sign-in
-- can create. A person who signs in with Google and a person who signs in with a
-- password are the same row, holding two nullable credentials, because the invite
-- is the single source of truth for membership.
--
-- No policy block, no grant. `user` is already tenant-scoped, already forced, and
-- already granted to `app_user` by the tenancy migration — a column inherits all
-- of that, which is the payoff of isolating on the table rather than per column.

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "google_subject" TEXT;

-- CreateIndex
--
-- Per tenant, deliberately, and not globally unique even though a Google subject
-- is globally unique to one person. A global constraint would read as the truer
-- one and would forbid the case this identity model is built around: the same
-- person working for two tenants is two Users, and each may link the same Google
-- account. See ADR 0001.
--
-- Postgres treats NULLs as distinct, so this constrains only the linked rows —
-- every User with no Google credential is unaffected.
CREATE UNIQUE INDEX "user_tenant_id_google_subject_key" ON "user"("tenant_id", "google_subject");
