-- The two-role split, locally.
--
-- Row-level security is the backstop beneath every tenant-scoped query, and
-- Postgres exempts superusers and BYPASSRLS roles from it entirely. If the
-- local runtime connected as the database owner, every policy would silently do
-- nothing here and the first time isolation was genuinely exercised would be
-- production — which is exactly the class of bug RLS exists to prevent.
--
-- So local development replicates the deployed split:
--
--   nivara_owner  superuser (POSTGRES_USER)  migrations + seeding  direct endpoint
--   app_user      NOSUPERUSER NOBYPASSRLS    all runtime queries   pooled endpoint
--
-- On Neon the same two roles exist for the same reason: the default owner is a
-- `neon_superuser` member and carries BYPASSRLS, so `app_user` is created there
-- by hand (this file's deployed counterpart) before the first migration runs.
--
-- This file runs once, as POSTGRES_USER, on an empty data directory. The
-- password is a throwaway local default and matches nothing deployed.

CREATE ROLE app_user
  LOGIN PASSWORD 'local_dev_only'
  NOSUPERUSER
  NOBYPASSRLS
  NOCREATEDB
  NOCREATEROLE
  NOINHERIT;

GRANT CONNECT ON DATABASE nivara TO app_user;

-- Read the schema, but never alter it. Table privileges are granted one table at
-- a time by the migration that creates them, alongside that table's policies —
-- so a table cannot arrive reachable but unprotected.
GRANT USAGE ON SCHEMA public TO app_user;
