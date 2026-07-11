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
cp .env.example .env   # DATABASE_URL and JWT_SECRET are the required keys
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
| `POST /auth/sign-in` | Email and password, scoped to `(tenantId, email)`. Returns a 15-minute access token; sets the refresh cookie. |
| `POST /auth/refresh` | Exchanges the refresh cookie for a new access token, rotating it. |
| `POST /auth/sign-out` | Revokes the token family and clears the cookie. |
| `GET /auth/me` | The authenticated principal, read through the tenant its own token armed. |
| `POST /staff/invitations` | Admin-only. Provisions a pending User and returns a single-use invitation token, shown once. |
| `POST /staff/invitations/accept` | Sets the invited User's password, spending the invitation. Public — the invitee has no credential yet. |
| `GET /health` | Liveness. Dependency-free — touches neither Postgres nor Redis, so a keep-warm ping never fails on a dependency blip. A readiness endpoint arrives alongside the dependencies it would check. |
| `GET /meta/error-codes` | The closed catalog of machine-readable error codes. |
| `GET /docs` | Browsable OpenAPI documentation. |
| `GET /openapi.json` | The generated OpenAPI document, for client generation. |

## Authentication

An invited User signs in with email and password. The lookup key is `(tenantId, email)`, never email alone — the same address at two Tenants is two Users with two passwords, which is what lets every table be tenant-scoped with no cross-tenant exception ([ADR-0001](docs/adr/0001-tenant-local-identity-model.md)).

A session is two halves, and they are deliberately different kinds of thing:

| | Access token | Refresh token |
|---|---|---|
| Form | JWT, HS256, claims `sub` / `tenantId` / `role` | Opaque 256-bit random — no claims to read |
| Lifetime | 15 minutes | 30-day sliding, 90-day absolute cap |
| Held | In memory, sent as `Authorization: Bearer` | httpOnly cookie, scoped to `/auth` |
| Stored | Nowhere — it is self-contained | `sha256` only; the raw value is unrecoverable |

The `tenantId` claim is the sole authority for which tenant a request acts in, and what arms `withTenant()`. It is never read from a body, a path, or a header, with one exception of a single shape: the two endpoints that exist to *establish* a credential — sign-in and invitation acceptance — take a `tenantId` in the body, because there is no credential yet to read it from. In both it is a routing input rather than an authority claim: it decides which tenant's rows the lookup can see, and being seen still requires the password or the invitation secret.

Refresh tokens **rotate on every use** and belong to a family. Presenting an already-rotated token means two parties hold the same secret with nothing to tell them apart, so the whole family is revoked: theft costs both parties the session rather than granting the thief a parallel one. The legitimate client signs in again — and so does nobody else.

Authentication resolves any credential into a uniform `RequestPrincipal`. Service tokens will add a second branch at that one seam and converge on the same shape, so there is never a second authorization path to drift out of sync with the first.

## Authorization

Authority is a vocabulary of named permissions with a static role-to-permission map ([src/authz/permissions.ts](src/authz/permissions.ts)) — what an `agent` may do is one table rather than a `role === 'admin'` scattered through controllers. An agent does the support work; an admin adds tenant configuration and destructive operations. The same vocabulary is the scope namespace for service tokens, so there is one set of permission names rather than two to keep in sync.

A permission guard runs after authentication and **fails closed**: an operation that declares no `@RequiresPermission()` is refused rather than published, and an operation that genuinely needs none says so with `@AuthenticatedOnly()`. Each requirement surfaces in the OpenAPI document as `x-required-permission`, derived from the same decorator the guard reads — so the published map cannot describe an authority the server does not enforce.

Row-level security sits beneath both guards. A guard bug refuses work that should have been allowed, or allows a call that should have been refused; it cannot show one tenant another tenant's rows.

Membership is deliberate: there is no self-service registration. An admin invites an address, which creates a User with no credential, and the invitee sets their password by spending a single-use invitation token.

Every route is authenticated unless it carries `@Public()`. Forgetting the decorator returns 401 and gets reported; the inverse default would publish a tenant's data with nothing to notice.

Seeded logins for the key-free demo path are printed by `npm run db:seed`.

## API conventions

Every endpoint obeys these, and they ship as reusable primitives rather than per-controller code — that is what keeps the generated document uniform across resources.

**Success.** Single resources come back bare. Collections wrap as `{ data, nextCursor }`. HTTP status discriminates success from error, so success bodies need no envelope of their own.

**Pagination.** Cursor/keyset, never offset — tickets and messages are high-insert tables where offset pagination drifts, skipping and duplicating rows mid-traversal. `limit` defaults to 25 and caps at 100. There is no `total`, not even opt-in: a COUNT under RLS and concurrent inserts is expensive and only half-true. Default order is `created_at DESC, id DESC`. The cursor is opaque — pass it back unmodified, and expect it to be rejected if you change `sort`.

**Errors.** Always `{ error: { code, message, details? } }`. Branch on `code`, never on `message`: codes are a closed `snake_case` catalog, published at `GET /meta/error-codes` and served from the same constant the server throws from. `details` appears only on 422. A record you cannot see returns **404, never 403** — a record belonging to another tenant must be indistinguishable from one that does not exist, or the status itself becomes a way to probe for other tenants' data.

**Unknown query parameters return 400**, never a silent ignore. A silently-ignored typo returns confidently wrong results and hides the client bug until someone notices the data is off.

**Filtering and sorting are per-resource allowlists**, not an open query language. Adding a filter is a deliberate, documented act — that cost is the point.

**Rate limits are per principal**, one uniform ceiling of 300 requests/minute keyed on the server-determined tenant and the caller — so one tenant's traffic can never consume another's budget. Exceeding it returns **429** with code `rate_limited` in the usual envelope, carrying `Retry-After` and `RateLimit-*` headers; back off by the seconds in `Retry-After`. There are deliberately no per-route or per-scope ceilings yet: a table of differentiated limits is easy to add and impossible to remove once clients depend on the differences.

Counters live in Redis and **fail open**. If Redis is unavailable the ceilings stop being enforced and every request is served — a cache outage should cost this API its protection, never its availability.

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

Every suite that touches the database runs **in band**, one at a time. They share one Postgres and one seed, and several of them assert over rows they did not create — a Ticket count, a job left undrained. Under Jest's default parallelism those assertions are races that pass or fail on worker scheduling, which is the worst kind of red: it appears when an unrelated suite is added and disappears when the file is run alone. `test:unit` stays parallel, because it opens no connection and has nothing to race against.

That is why the `*.int-spec.ts` files are in the **default** run rather than behind an opt-in flag. They are the only thing that demonstrates isolation actually holds, and they connect as `app_user` — point them at the owner instead and every one of their assertions collapses. A suite that stayed green while RLS was disabled would be worse than no suite. `test:unit` exists for the tight loop, not as the thing CI runs.

## Configuration

Entirely environment-driven. [.env.example](.env.example) documents every key; nothing real is committed. Absence of an optional integration is a supported state. Half-configuring one is not — supplying a client id without its secret fails at boot rather than at the first callback.

`REDIS_URL` is optional on the same terms. Everything that uses it fails open, so a process without Redis serves every request correctly and simply enforces no rate limits — which is what keeps the credential-free first run working. The three `RATE_LIMIT_*_PER_MINUTE` ceilings are starting values, tunable per environment.
