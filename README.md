# Nivara Desk API

A multitenant, two-sided customer-support helpdesk API. Every record belongs to exactly one Tenant, and tenant identity is always server-determined — read from the auth token or channel context, never from client input.


## Running it

```bash
docker compose up
```

That is the whole first run. No credentials, no keys, no manual steps — a clean clone migrates the schema, seeds two tenants, and comes up on `http://localhost:3000`. Optional integrations (Google sign-in, Slack ingestion) are dormant when unconfigured rather than fatal, which is what makes a key-free start possible.

For a local run outside compose:

```bash
npm install
cp .env.example .env   # DATABASE_URL is the only required key
docker compose up -d postgres
npm run db:migrate && npm run db:seed
npm run start:dev
```

## Tenant isolation

Isolation is a property of the database, not a discipline in application code. Every tenant-scoped table has Postgres row-level security enabled and forced, with a policy predicated on a transaction-local setting. A forgotten `where` in a service cannot leak another tenant's rows, because Postgres never returns them.

Two roles make that guarantee real:

| Role | | |
|---|---|---|
| `nivara_owner` | Superuser locally, `neon_superuser` (so `BYPASSRLS`) on Neon | Migrations and seeding only, over the **direct** endpoint. `MIGRATE_DATABASE_URL`. |
| `app_user` | `NOSUPERUSER NOBYPASSRLS`, and not the table owner | Every request-path query, over the **pooled** endpoint. `DATABASE_URL`. |

The owner credential is absent from the running process — the application refuses to boot in production if it finds one — because row-level security is only a guarantee while nothing in the process can bypass it. Locally, [docker/postgres/init](docker/postgres/init) creates the same split so development exercises the real policies rather than silently bypassing them.

Context is armed by `TenancyService.withTenant()`, which opens a Prisma interactive transaction and issues `set_config(..., true)` as its first statement — transaction-local, never session-level, because a session-level `SET` survives the transaction and leaks onto the next client under transaction-mode pooling. It arms the actor (`app.current_actor_kind`, `app.current_actor_id`) that the audit triggers read as well; an absent actor raises rather than defaulting.

```ts
const tickets = await tenancy.withTenant(
  { tenantId, actor: { kind: 'user', id: userId } },
  (tx) => tx.ticket.findMany(),
);
```

Background: [docs/research/rls-neon-pooling.md](docs/research/rls-neon-pooling.md).

## What is here

| Endpoint | |
|---|---|
| `GET /health` | Liveness. Dependency-free — touches neither Postgres nor Redis, so a keep-warm ping never fails on a dependency blip. A readiness endpoint arrives alongside the dependencies it would check. |
| `GET /meta/error-codes` | The closed catalog of machine-readable error codes. |
| `GET /docs` | Browsable OpenAPI documentation. |
| `GET /openapi.json` | The generated OpenAPI document, for client generation. |

## API conventions

Every endpoint obeys these, and they ship as reusable primitives rather than per-controller code — that is what keeps the generated document uniform across resources.

**Success.** Single resources come back bare. Collections wrap as `{ data, nextCursor }`. HTTP status discriminates success from error, so success bodies need no envelope of their own.

**Pagination.** Cursor/keyset, never offset — tickets and messages are high-insert tables where offset pagination drifts, skipping and duplicating rows mid-traversal. `limit` defaults to 25 and caps at 100. There is no `total`, not even opt-in: a COUNT under RLS and concurrent inserts is expensive and only half-true. Default order is `created_at DESC, id DESC`. The cursor is opaque — pass it back unmodified, and expect it to be rejected if you change `sort`.

**Errors.** Always `{ error: { code, message, details? } }`. Branch on `code`, never on `message`: codes are a closed `snake_case` catalog, published at `GET /meta/error-codes` and served from the same constant the server throws from. `details` appears only on 422. A record you cannot see returns **404, never 403** — a record belonging to another tenant must be indistinguishable from one that does not exist, or the status itself becomes a way to probe for other tenants' data.

**Unknown query parameters return 400**, never a silent ignore. A silently-ignored typo returns confidently wrong results and hides the client bug until someone notices the data is off.

**Filtering and sorting are per-resource allowlists**, not an open query language. Adding a filter is a deliberate, documented act — that cost is the point.

## Development

```bash
npm run typecheck     # tsc --noEmit
npm test              # everything — needs a migrated, seeded Postgres
npm run test:unit     # the subset that opens no connection
npm run test:int      # the isolation proof alone
npm run lint
npm run openapi:emit  # writes openapi.json
```

Tests run at two seams and no others: the booted application driven over its public protocols (Supertest for HTTP), and — once the scheduler exists — a directly-invokable scheduler tick. Tests do not mock the data layer. The load-bearing invariants in this system live in SQL rather than in application code, so a test that mocks Postgres proves nothing about them.

That is why the `*.int-spec.ts` files are in the **default** run rather than behind an opt-in flag. They are the only thing that demonstrates isolation actually holds, and they connect as `app_user` — point them at the owner instead and every one of their assertions collapses. A suite that stayed green while RLS was disabled would be worse than no suite. `test:unit` exists for the tight loop, not as the thing CI runs.

## Configuration

Entirely environment-driven. [.env.example](.env.example) documents every key; nothing real is committed. Absence of an optional integration is a supported state. Half-configuring one is not — supplying a client id without its secret fails at boot rather than at the first callback.
