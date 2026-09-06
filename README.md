# nivara-api

![NestJS](https://img.shields.io/badge/NestJS-E0234E?style=flat&logo=nestjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?style=flat&logo=postgresql&logoColor=white)
![Prisma](https://img.shields.io/badge/Prisma-2D3748?style=flat&logo=prisma&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-FF4438?style=flat&logo=redis&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?style=flat&logo=docker&logoColor=white)
![OpenAPI](https://img.shields.io/badge/OpenAPI-6BA539?style=flat&logo=openapiinitiative&logoColor=white)

[Live](https://nivara-api-nestjs.onrender.com/health)  ·
[OpenAPI docs](https://nivara-api-nestjs.onrender.com/docs)  ·
[The product](https://nivara-landing-iota.vercel.app)

The API behind [Nivara Desk](https://nivara-landing-iota.vercel.app): a multitenant, two-sided
customer-support helpdesk. NestJS, Postgres, Prisma, Redis.

Every record belongs to exactly one tenant, and tenant identity is always server-determined — read
from the auth token or the channel context, never from client input. Isolation is a property of the
database rather than a discipline in application code: every tenant-scoped table has Postgres
row-level security **enabled and forced**, and the request-path role is neither superuser nor table
owner, so a forgotten `where` cannot leak another tenant's rows.

**[Live](https://nivara-api-nestjs.onrender.com/health)** ·
**[OpenAPI docs](https://nivara-api-nestjs.onrender.com/docs)** ·
[`openapi.json`](https://nivara-api-nestjs.onrender.com/openapi.json)

## Running it

```bash
docker compose up
```

That is the whole first run. No credentials, no keys, no manual steps — a clean clone migrates the
schema, seeds two tenants, and comes up on `http://localhost:3000`. Optional integrations (Google
sign-in, Slack ingestion) are dormant when unconfigured rather than fatal, which is what makes a
key-free start possible.

Outside compose:

```bash
npm install
cp .env.example .env          # DATABASE_URL, JWT_SECRET, WIDGET_SESSION_SECRET are required
docker compose up -d postgres
npm run db:migrate && npm run db:seed
npm run start:dev
```

[docker/postgres/init](docker/postgres/init) creates the same two-role split locally that the
deployment uses, so development exercises the real RLS policies rather than silently bypassing them.

## The seeded demo

`npm run db:seed` builds two tenants and prints the credentials for both. Sign-in is email and
password, so the demo path needs no OAuth provider.

| | |
|---|---|
| Tenant | `5eed0000-0000-4000-8000-000000000001` |
| Email | `admin@meridian.test` |
| Password | `nivara-demo-password` |

**Meridian** is the showcase: five staff, twenty contacts, fifty tickets across the last six weeks,
covering every state, priority and source, with real threads and internal notes. Its SLA clocks
include breached, paused and still-running ones, and eight to ten tickets were answered and closed
by the AI layer alone — so deflection is non-zero on the first request rather than after somebody
constructs the data by hand.

**Sortwood** is the isolation tenant: three staff, three contacts, five tickets, small on purpose.
One tenant makes isolation unfalsifiable — every query returns the only rows that exist — and a
second one small enough to read end to end lets a developer check the claim instead of trusting it.

Every timestamp is relative to the moment the seed ran. The seed truncates before it writes, so
re-running it is how you reset to a known state. A handful of ids are fixed across runs and live in
[prisma/seed/anchors.ts](prisma/seed/anchors.ts).

## What is here

| | |
|---|---|
| **Auth** | Email + password scoped to `(tenantId, email)`, 15-minute access tokens, rotating refresh cookies, admin invitations, optional Google OIDC onto an invited user. |
| **Tickets** | Keyset pagination, allowlisted filters and sorts, a database-enforced state machine, priorities, assignment, linkage and reply-reopen. |
| **Conversation** | Customer-visible messages and agent-only notes on the same thread, with audience enforced server-side. |
| **Real-time** | WebSocket rooms with per-room sequence numbers, a bounded replay buffer, and an explicit gap signal when a client falls behind it. |
| **SLA** | First-response and resolution clocks with pause, breach latches and dwell sweeps, driven by a Postgres-queue scheduler. |
| **Analytics** | Tenant-scoped aggregates — four rates and two percentiles — behind their own `analytics:read` scope. |
| **Widget** | Anonymous, origin-checked sessions minted for a visitor on a tenant's own site. |
| **Slack** | Inbound ingestion into tickets and reply-back delivery to the originating thread. |
| **Audit** | Append-only, with actor attribution enforced by database trigger rather than supplied by the code being audited. |

Full request and response shapes are in the [OpenAPI document](https://nivara-api-nestjs.onrender.com/docs);
the machine-readable error catalog is served from `GET /meta/error-codes`.

## Conventions worth knowing before you call it

- Single resources come back bare; collections wrap as `{ data, nextCursor }`.
- Pagination is cursor/keyset, never offset, and there is no `total`.
- Errors are always `{ error: { code, message, details? } }` — branch on `code`, never on `message`.
- A record you cannot see returns **404, never 403**, so the status cannot be used to probe for
  another tenant's data.
- An unknown query parameter is a **400**, never a silent ignore.
- Rate limits are per principal, 300/minute, and **fail open** if Redis is unavailable.

## Development

```bash
npm run typecheck
npm run lint
npm test              # everything — needs a migrated, seeded Postgres
npm run test:unit     # drops the isolation suites; still needs Postgres
npm run test:int      # the isolation proof alone
npm run openapi:emit
```

Tests do not mock the data layer. The load-bearing invariants in this system live in SQL rather
than in application code, so a test that mocks Postgres proves nothing about them — which is also
why the `*.int-spec.ts` isolation suites are in the default run rather than behind a flag. They
connect as `app_user`; point them at the owner instead and every assertion collapses.

Database suites run **in band**. They share one Postgres and one seed, and several assert over rows
they did not create.

## Configuration and deployment

Entirely environment-driven — [.env.example](.env.example) documents every key and nothing real is
committed. Absence of an optional integration is supported; half-configuring one fails at boot
rather than at the first callback.

The image that runs locally is the image that deploys, and **no file here names a platform**: the
deployment is a container wanting a `DATABASE_URL`, an optional `REDIS_URL`, two signing secrets
and a port. Migrations run as a release step
([`.github/workflows/release.yml`](.github/workflows/release.yml)), never at boot, and the owner
credential is a CI secret the running process is never given.

Two health endpoints, not interchangeable: `GET /health` is liveness and touches nothing;
`GET /health/ready` does a database round-trip, Redis's status and the scheduler heartbeat.

## Where the reasoning is

The decisions behind the awkward parts — tenant-local identity, composite foreign keys, CORS split
by credential model — are in [`docs/adr/`](docs/adr), one file each.
[`CONTEXT.md`](CONTEXT.md) is the vocabulary the code is written in.
[`docs/research/rls-neon-pooling.md`](docs/research/rls-neon-pooling.md) covers RLS over a
transaction-mode pooler, and [`docs/realtime/SCHEMA.md`](docs/realtime/SCHEMA.md) is the WebSocket
event contract.
