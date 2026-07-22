# Deployment runbook

First deploy of the API onto Neon (Postgres) + Render (web service), free tiers, created by hand.

Nothing in the repository names a platform or pins a region — see [README.md](../README.md#deployment). This runbook is one concrete way to satisfy the deployment's actual requirements, which are smaller than they look:

> a container, given `DATABASE_URL`, two signing secrets, a port to listen on, and a schema that has already been migrated.

Any container host meets that. Render is what this one uses. Upstash (Redis) is optional throughout.

Commands below that touch GitHub run in a clone of this repository; migration and seed commands need only `prisma/` and a connection string.

## Pick the region first, and pick it once

You are in India. The nearest option on both platforms is **Singapore** — neither offers Mumbai:

| | Region to choose |
|---|---|
| Render | Singapore |
| Neon | AWS Asia Pacific (Singapore) — `aws-ap-southeast-1` |

> [!WARNING]
> **Neither platform can change a region after creation.** Render "doesn't currently support changing the region for an existing service or database"; Neon requires creating a new project and migrating into it. Getting this wrong means rebuilding both, so set it before anything else. This is exactly why no file in the repo decides it for you.

Keep the database and the service in the same region. A Singapore app talking to an Oregon database pays a round trip on every query, and this app makes several per request.

## The one ordering that must hold

`app_user` must exist **before the first migration**. Every migration `GRANT`s table privileges to it *by name* ([`20260718073146_tenancy_spine`](../prisma/migrations/20260718073146_tenancy_spine/migration.sql) onward), so `prisma migrate deploy` fails on its first `GRANT` if the role is missing.

Beyond that the sequence is forgiving, because deploys are manual now: the schema is applied by CI or by you, and the service starts when you press a button, so nothing can race ahead of anything.

---

## 1. Neon — create the project

- [ ] Create a project at [console.neon.tech](https://console.neon.tech), region **Singapore**.
- [ ] Note the database name (`neondb` by default) and the owner role (`neondb_owner`).
- [ ] From **Connect**, copy **both** connection strings — toggle the pooled option to get the second:

| | Hostname | Used by |
|---|---|---|
| **Direct** | `ep-xxx.ap-southeast-1.aws.neon.tech` | `MIGRATE_DATABASE_URL` — migrations, seeding |
| **Pooled** | `ep-xxx-pooler.ap-southeast-1.aws.neon.tech` | `DATABASE_URL` — the running service |

Pooled strings include `-pooler` in the hostname; direct strings do not. Keep `?sslmode=require` (and `channel_binding` if present) exactly as given — only the host and credentials differ between the two.

The runtime is safe on the pooled endpoint because tenant context is set transaction-locally with `set_config(..., true)`, so it cannot leak across PgBouncer's transaction-mode reuse. Migrations need the direct endpoint, which is why the two are separate variables.

## 2. Neon — create `app_user`

The deployed counterpart of [docker/postgres/init/01-app-user.sql](../docker/postgres/init/01-app-user.sql).

This must be done by hand because Neon's own owner cannot be the runtime role: roles created in the Neon Console, CLI, or API are granted membership in `neon_superuser`, which carries `BYPASSRLS`. A runtime connected as that role makes every RLS policy silently a no-op. Roles created from an SQL client are *not* assigned `neon_superuser` — which is why this is SQL and not a console click.

- [ ] Generate a password: `openssl rand -base64 24`
- [ ] In the Neon **SQL Editor**, connected as owner, with both placeholders replaced:

```sql
CREATE ROLE app_user
  LOGIN PASSWORD '<APP_USER_PASSWORD>'
  NOSUPERUSER
  NOBYPASSRLS
  NOCREATEDB
  NOCREATEROLE
  NOINHERIT;

GRANT CONNECT ON DATABASE <DBNAME> TO app_user;

-- Read the schema, never alter it. Table privileges arrive one table at a time
-- from the migration that creates each table, alongside that table's policies,
-- so a table cannot arrive reachable but unprotected.
GRANT USAGE ON SCHEMA public TO app_user;
```

- [ ] **Verify before continuing.** Both flags must come back `f`:

```sql
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'app_user';
```

If `rolbypassrls` is `t`, stop. Tenant isolation is not being enforced, and the integration suite would pass anyway — the one failure mode this whole split exists to prevent.

- [ ] Assemble the two URLs and keep them for the rest of the runbook:

```
MIGRATE_DATABASE_URL   direct host  + neondb_owner credentials
DATABASE_URL           -pooler host + app_user credentials
```

`DATABASE_URL` is the console's pooled string with `neondb_owner:<pw>` swapped for `app_user:<pw>`.

## 3. Migrate

Inline rather than written into `.env`, because [prisma.config.ts](../prisma.config.ts) loads `dotenv/config`, which does not override variables already set in the environment — so the inline value wins and your local `.env` stays pointed at compose.

- [ ] Apply the migrations:

```bash
MIGRATE_DATABASE_URL='<direct owner url>' npm run release
```

Same command CI runs and the same one local compose runs.

- [ ] Confirm they landed — expect **18**, matching [prisma/migrations/](../prisma/migrations/):

```sql
SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL;
```

## 4. Seed — once

> [!WARNING]
> **The seed is destructive and not idempotent.** `reset()` in [prisma/seed/database.ts](../prisma/seed/database.ts) runs `TRUNCATE TABLE "tenant" CASCADE`, briefly disabling the `audit_log` no-truncate trigger to do it. Truncate-then-insert is deliberate — it is what makes "reset to a known state" true — but running it against a deployment holding real data erases every tenant. Run it now, on the empty database, and never again without meaning it.

- [ ] Seed:

```bash
MIGRATE_DATABASE_URL='<direct owner url>' npm run db:seed
```

- [ ] **Capture the output.** It prints the Meridian service token in the clear, exactly once and nowhere else — losing it means reseeding, which is the same story the mint endpoint tells a real admin. It also prints the seeded sign-ins and the stable reference Ticket ids.

Two tenants land: **Meridian** (showcase) and **Sortwood** (so isolation can be checked by hand rather than taken on trust).

> [!NOTE]
> Every seeded principal shares one hardcoded password, `nivara-demo-password`, which is in a public repository. That is correct for a showcase and is what makes it evaluable with no credential exchange — but **anyone can sign in to this deployment**. Treat it as a demo, never as somewhere real data goes.

## 5. Upstash — Redis (optional)

Skippable. Everything behind Redis fails open, so a deployment without it serves every request correctly and simply enforces no rate-limit ceilings — reported `dormant` on `/health/ready`, never a 503.

- [ ] Create a Redis database at [console.upstash.com](https://console.upstash.com), Singapore region.
- [ ] Copy the TCP connection string. TLS is on by default and cannot be disabled, so it is `rediss://` (two s's):

```
rediss://default:<PASSWORD>@<endpoint>.upstash.io:6379
```

No extra configuration needed — [redis.service.ts](../src/redis/redis.service.ts) passes the URL straight to `new Redis(...)`, and ioredis enables TLS from the scheme itself.

## 6. Render — create the service by hand

**New → Web Service → Existing Image / Build from repository**, pointing at `rishabh0111/nivara-api-nestjs`.

- [ ] **Region: Singapore.** One shot — see the warning at the top.
- [ ] **Runtime: Docker.** It should detect the [Dockerfile](../Dockerfile) at the repo root. No build or start command to set; the image defines both.
- [ ] **Instance type: Free.**

### The settings that used to be asserted by a test

These five were enforced by `render.yaml` and are now yours to set correctly. They are listed together because they are the whole of what the blueprint was doing.

- [ ] **Health check path: `/health`.** Liveness, never `/health/ready`. Failing this restarts the instance, and readiness reports conditions that are not reasons to restart — a database blip resolves itself, and a restart during one kills the process that would have recovered.
- [ ] **Auto-Deploy: Off.** Deploys are manual. With it on, a push deploys immediately and can beat the migration that CI is still applying.
- [ ] **Environment variables**, exactly these:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | `app_user` over the **`-pooler`** host (step 2) |
| `REDIS_URL` | the `rediss://` URL — **omit entirely** if you skipped Upstash |
| `JWT_SECRET` | `openssl rand -base64 32` |
| `WIDGET_SESSION_SECRET` | `openssl rand -base64 32` — **a different value**, not a reuse |
| `RUN_SCHEDULER` | `true` |
| `SWAGGER_ENABLED` | `true` |
| `RATE_LIMIT_AUTHENTICATED_PER_MINUTE` | `300` |
| `RATE_LIMIT_SLACK_IP_PER_MINUTE` | `60` |
| `RATE_LIMIT_SLACK_GLOBAL_PER_MINUTE` | `600` |

- [ ] The two signing secrets are **deliberately different values**. A widget session and a staff token are signed by different keys, so a token minted for one surface fails to verify on the other at the signature, before any claim is read. Reusing one value silently removes that.
- [ ] **Do not set `MIGRATE_DATABASE_URL`.** Its absence *is* the role split: the owner credential lives only in CI, so the running process is never given anything that can bypass RLS. Two belts sit under this — the entrypoint `env -u`s the variable, and the app refuses to boot in production if it finds one — but the absence is the guarantee.
- [ ] **Leave `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` and `SLACK_SIGNING_SECRET` / `SLACK_BOT_TOKEN` unset.** Absence is a supported state; supplying one half of a pair fails at boot by design. Do not set them to empty strings.
- [ ] Do **not** set `PORT`. The platform supplies it and the app reads it.

Then:

- [ ] Create the service and let the first deploy run. The schema already exists, so this is a normal boot.
- [ ] Note the URL: `https://nivara-api-xxxx.onrender.com`.

## 7. Wire CI for migrations

The workflow ([`.github/workflows/release.yml`](../.github/workflows/release.yml)) applies the schema on a push to `main` and stops there. It triggers no deploy.

- [ ] Set the one secret it needs, from a clone of this repository:

```bash
gh secret set MIGRATE_DATABASE_URL   # paste the direct owner URL
gh secret list
```

Until that exists the workflow is inert — skipped, not failed, because a clone with no deployment is a supported state.

- [ ] Prove it without pushing a commit:

```bash
gh workflow run Release
gh run watch
```

Both jobs should run rather than skip. The migration is a no-op — everything is already applied — which is the point: it proves the credential and the path work while changing nothing.

## 8. Keep-warm

Required, and it has to come from outside the service it keeps awake.

Render spins down a free web service after **15 minutes** without inbound traffic, and cold start takes about a minute. The scheduler runs in-process, so a sleeping service is a stopped ticker.

- [ ] Point an external monitor at `GET https://<service>.onrender.com/health` every **5 minutes** — comfortably inside the idle window. Both numbers are constants in [src/health/keep-warm.ts](../src/health/keep-warm.ts) with a test over the relationship between them. [cron-job.org](https://cron-job.org) or [UptimeRobot](https://uptimerobot.com) do this free.
- [ ] Target `/health`, **not** `/health/ready`. Liveness touches nothing; readiness makes a database round trip, and billing a query every 5 minutes against a free Postgres for no reason is the wrong trade.

Correctness does not rest on the ping arriving. Both scheduler ticks fire on state rather than on events, so a missed ping delays sweep work instead of losing it ([test/deployment.int-spec.ts](../test/deployment.int-spec.ts)).

## 9. Verify

- [ ] `curl https://<service>/health` → `200`, touching nothing.
- [ ] `curl https://<service>/health/ready` → `200`. Check the body: database `ok`, scheduler heartbeat present, Redis `ok` — or `dormant` if you skipped Upstash, `degraded` if configured and not answering. Neither Redis state fails the check, and neither means a broken deployment.
- [ ] `https://<service>/docs` → Swagger UI.
- [ ] Sign in, with a tenant id from the seed output:

```bash
curl -X POST https://<service>/auth/sign-in \
  -H 'Content-Type: application/json' \
  -d '{"tenantId":"<meridian id>","email":"admin@meridian.test","password":"nivara-demo-password"}'
```

- [ ] **Check isolation against the real deployment**, which is the one thing local compose cannot tell you — RLS is only meaningful over the credentials actually in use. Sign in as `admin@sortwood.test` and request a Meridian Ticket id from the seed output. Expect a 404, from the policy rather than from a handler.

## Releasing, afterwards

Two steps, in this order, and the order is the whole contract:

1. Push to `main`. CI applies the migrations and stops. Watch it go green.
2. Press **Manual Deploy → Deploy latest commit** in the Render dashboard.

Nothing races, because step 2 does not begin until you begin it. If step 1 fails, do not do step 2 — the running instance is still correct against the schema it was built for.

- **Rolling back a bad migration is a forward migration.** `prisma migrate deploy` does not go backwards.
- **Rolling back code** is Render's rollback to a previous deploy, and it is only safe while the old image still matches the current schema — which is the ordinary reason to keep migrations additive.
- **Splitting the scheduler out**: set `RUN_SCHEDULER=false` on the web service and add a second service with it `true`. Running both is safe too — the drain claims with `SELECT … FOR UPDATE SKIP LOCKED` and the sweeps fire on set-once predicates.
- **Rotating `app_user`'s password** is `ALTER ROLE app_user PASSWORD '...'` plus the new `DATABASE_URL` in the dashboard. Rotating the owner's is the Neon console plus the `MIGRATE_DATABASE_URL` GitHub secret.

## Porting off Render

The requirement is a container with `DATABASE_URL`, two signing secrets, and a port. To move: build the same [Dockerfile](../Dockerfile), set the same variables from step 6, point the health check at `/health`, keep deploys manual or add a pre-deploy hook that runs `npm run release`, and keep something pinging `/health` if the new host also sleeps idle services. Nothing in the repository needs to change.

## Sources

Platform behaviour above was checked against:

- [Regions — Render](https://render.com/docs/regions) — the five regions; region cannot be changed after creation
- [Deploy for Free — Render](https://render.com/docs/free) — 15-minute idle spin-down, ~1 minute cold start
- [Deploying on Render](https://render.com/docs/deploys) — manual deploys, auto-deploy setting
- [Regions — Neon](https://neon.com/docs/introduction/regions) and [Can I change the region of my existing Neon project?](https://neon.com/faqs/change-project-region) — Singapore is the nearest to India; region is fixed at creation
- [Connection pooling — Neon](https://neon.com/docs/connect/connection-pooling) and [Choosing your connection method — Neon](https://neon.com/docs/connect/choose-connection) — `-pooler` hostnames, migrations on the direct endpoint
- [Manage roles — Neon](https://neon.com/docs/manage/roles) — `neon_superuser` carries `BYPASSRLS`; SQL-created roles do not join it
- [Connect your client — Upstash](https://upstash.com/docs/redis/howto/connect-client) — TLS on by default, `rediss://` connection string
