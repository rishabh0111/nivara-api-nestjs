# RLS enforcement over Neon's pooled (PgBouncer transaction-mode) connection

Research note on RLS enforcement over the Neon transaction-mode pooler.
Investigated 2026-07-15 against primary sources (PostgreSQL, PgBouncer, Prisma, Neon docs). Every non-obvious claim is cited inline; see [Sources](#sources).

---

## Executive summary

- **Set the tenant GUC transaction-locally, never session-level.** Under Neon's pooler (PgBouncer **transaction mode**) a physical server connection is handed to a client only for the duration of one transaction and then returned to the pool. A session-level `SET` persists on that physical connection and **leaks into the next client's transaction**; PgBouncer explicitly lists `SET`/`RESET` as *never* compatible with transaction pooling. `SET LOCAL` (or `set_config(name, value, true)`) is scoped to the current transaction and is reverted at COMMIT/ROLLBACK — this is the correct, pooler-safe mechanism.
- **The Prisma pattern is an interactive `$transaction` that first runs `SET LOCAL` (preferably `set_config(..., true)`) and then all tenant queries on that same `tx` client** — because every query inside an interactive transaction runs on one connection inside one DB transaction. A Client extension (`$allOperations`) can wrap each op in such a transaction so callers don't have to remember.
- **RLS policies** use `USING` (read/visibility filter) and `WITH CHECK` (write validation) referencing `current_setting('app.current_tenant', true)` — the `true`/`missing_ok` argument makes an unset GUC return `NULL` instead of raising, so unset context matches no rows (fail-closed) rather than erroring.
- **The app must connect as a dedicated, least-privileged role with NO `BYPASSRLS`.** On Neon this is the trap: the default owner role (`neondb_owner`, a `neon_superuser` member) carries `BYPASSRLS` and silently bypasses every policy. Migrations and seeding run as that owner (bypass by design); runtime queries must use a separate restricted `app_user`. Also `ALTER TABLE ... FORCE ROW LEVEL SECURITY` so even a table-owning role is subject to policies.
- **Gotchas:** SQL-level prepared statements don't work through the pooler (append `?pgbouncer=true` for PgBouncer <1.21, and use a `directUrl` for migrations); `SET` cannot take a bind parameter, so prefer the parameterizable `set_config('app.current_tenant', $1, true)` over string-interpolated `SET LOCAL`.

---

## 1. Setting the per-request tenant GUC so it survives the pooler

### Why session-level `SET` is unsafe under transaction pooling

Neon's connection pooler is **PgBouncer running in transaction mode** ([Neon: Connection pooling](https://neon.com/docs/connect/connection-pooling)). In transaction mode, *"A server connection is assigned to a client only during a transaction. When PgBouncer notices that the transaction is over, the server will be put back into the pool."* ([PgBouncer: Features / pooling modes](https://www.pgbouncer.org/features.html)).

A session-level `SET` (= `SET SESSION`) persists on the *physical* connection: per PostgreSQL, *"Once the surrounding transaction is committed, the effects will persist until the end of the session, unless overridden by another `SET`."* ([PostgreSQL: SET](https://www.postgresql.org/docs/current/sql-set.html)). Because the pooler recycles that physical connection to a *different* client after the transaction ends, the GUC set by client A is still present for client B — a cross-tenant leak. This is why PgBouncer's compatibility table marks **`SET`/`RESET` as "Never"** compatible with transaction pooling ([PgBouncer](https://www.pgbouncer.org/features.html)), and why Neon lists *"SET / RESET (session variables)"* among features **not supported with pooled connections** ([Neon: Connection pooling](https://neon.com/docs/connect/connection-pooling)).

### Why `SET LOCAL` is correct

`SET LOCAL` is scoped to the transaction: *"The effects of `SET LOCAL` last only till the end of the current transaction, whether committed or not."* ([PostgreSQL: SET](https://www.postgresql.org/docs/current/sql-set.html)). Equivalently, `set_config(name, value, is_local => true)`: *"If `is_local` is `true`, the new value will only apply during the current transaction."* ([PostgreSQL: system admin functions](https://www.postgresql.org/docs/current/functions-admin.html)).

Because the GUC is torn down at COMMIT/ROLLBACK — before the pooler returns the connection to the pool — nothing leaks to the next client. The one hard requirement is that the `SET LOCAL` and the queries that depend on it run **inside the same transaction on the same connection** (see §2).

### Comparison

| Option | Survives pooler safely? | Verdict |
|---|---|---|
| **(a) `SET LOCAL` / `set_config(...,true)` inside an interactive `$transaction`** | Yes — transaction-scoped, reverted before connection is returned to the pool | **Correct. Use this.** |
| (b) Session-level `SET app.current_tenant = ...` | **No** — persists on the physical connection and leaks to the next pooled client | Unsafe under transaction pooling; PgBouncer marks it "Never" |
| (c) Neon unpooled/direct endpoint (no `-pooler` host) with session `SET` | Technically works (dedicated connection), but throws away pooling and doesn't scale to 10k connections | Reserve the direct endpoint for **migrations/admin**, not per-request app traffic |

Neon recommends the **unpooled** connection (host without the `-pooler` suffix) for *"schema migrations … and admin tasks requiring session-level features"* ([Neon: Connection pooling](https://neon.com/docs/connect/connection-pooling)) — that is the right home for migrations and seeding, not for request-path RLS context.

---

## 2. The concrete Prisma pattern (and Spring / FastAPI equivalents)

### Why an interactive transaction is required

In a Prisma interactive transaction, *"all queries inside it have to be run on the same connection"* and execute serially on that one connection ([Prisma: Transactions](https://www.prisma.io/docs/orm/prisma-client/queries/transactions)). That guarantee — one connection, one DB transaction — is exactly what makes `SET LOCAL` visible to the subsequent queries and torn down afterward. A bare `prisma.$executeRaw('SET LOCAL ...')` followed by `prisma.user.findMany()` is **wrong**: those are two separate pool checkouts, so the second query may land on a different connection with no tenant context set.

### Preferred: `set_config(..., true)` with a bound parameter

`SET` does not accept a bind parameter for its value, and Prisma's safe tagged-template `$executeRaw` sends statements as prepared statements — Prisma notes *"PostgreSQL's `ALTER` command cannot use prepared statements"* and the same class of DDL/utility limitation applies, which is why `$executeRawUnsafe` exists for those ([Prisma: raw queries](https://www.prisma.io/docs/orm/prisma-client/using-raw-sql/raw-queries)). The clean way to keep a **bound, injection-safe** value is the function form `set_config('app.current_tenant', $1, true)`, which *does* take a normal parameter:

```ts
async function withTenant<T>(
  prisma: PrismaClient,
  tenantId: string,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(async (tx) => {
    // Bound parameter -> no SQL injection, transaction-local (3rd arg = is_local = true)
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
    return work(tx);
  });
}

// usage
const tickets = await withTenant(prisma, ctx.tenantId, (tx) =>
  tx.ticket.findMany(),           // RLS now filters by current_setting('app.current_tenant')
);
```

`${tenantId}` in the tagged template is escaped/parameterized by Prisma ([Prisma: raw queries](https://www.prisma.io/docs/orm/prisma-client/using-raw-sql/raw-queries)). If you insist on literal `SET LOCAL`, the value cannot be bound and you must fall back to `tx.$executeRawUnsafe(\`SET LOCAL app.current_tenant = '${validatedUuid}'\`)` — only ever with a server-validated UUID, never raw client input. `set_config(...)` avoids this footgun entirely.

### Ergonomic: a Client extension so callers can't forget

A `query` extension wrapping `$allOperations` can push every model op into a tenant-scoped transaction. The extension callback receives `{ model, operation, args, query }` and runs custom logic before `query(args)` ([Prisma: query extensions](https://www.prisma.io/docs/orm/prisma-client/client-extensions/query)):

```ts
function forTenant(base: PrismaClient, tenantId: string) {
  return base.$extends({
    query: {
      $allModels: {
        async $allOperations({ args, query }) {
          return base.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT set_config('app.current_tenant', ${tenantId}, true)`;
            // re-run this operation on the tx connection
            return (tx as any)[/* model */][/* op */](args);
          });
        },
      },
    },
  });
}
```

> Note: the `$allOperations` wrapper cannot by itself redirect `query()` onto the `tx` connection — `query()` runs on the base client. In practice the robust, portable shape is the explicit `withTenant($transaction)` helper above (used per request via a NestJS request-scoped provider / interceptor that reads `tenantId` from the validated JWT), rather than trying to make the extension both open the transaction and re-dispatch the op. Keep the invariant in SQL (RLS + `set_config`), and keep the framework glue thin — that is what ports cleanly.

### Portability (same invariant, three stacks)

The invariant lives in SQL (`set_config('app.current_tenant', <id>, true)` at the start of each transaction, plus the RLS policies). Only the "run this at transaction start" hook differs per framework:

- **Spring (Hibernate / JDBC):** wrap `@Transactional` boundaries so that just after the transaction begins you execute the GUC on the *same* JDBC `Connection`. Typical implementations: an AOP aspect around `@Transactional`, a `TransactionSynchronization` registered in `afterBegin`, or unwrapping the Hibernate `Session` via `session.doWork(conn -> ...)`:
  ```java
  session.doWork(conn -> {
    try (PreparedStatement ps =
        conn.prepareStatement("SELECT set_config('app.current_tenant', ?, true)")) {
      ps.setString(1, tenantId);
      ps.execute();
    }
  });
  ```
  (Portability shape verified against Postgres `set_config` semantics; the Spring wiring choice is implementation detail, not a Neon/Postgres fact.)

- **FastAPI (SQLAlchemy):** register an event listener on the `Session`'s `after_begin` event and issue the GUC on the connection the transaction just opened:
  ```python
  from sqlalchemy import event, text

  @event.listens_for(Session, "after_begin")
  def set_tenant(session, transaction, connection):
      tid = session.info.get("tenant_id")
      connection.execute(
          text("SELECT set_config('app.current_tenant', :tid, true)"),
          {"tid": tid},
      )
  ```
  `after_begin` fires once per transaction on the bound connection, which is the SQLAlchemy analogue of Prisma's interactive-transaction start.

All three set a **transaction-local** GUC on the one connection the transaction owns — identical semantics, pooler-safe everywhere.

---

## 3. RLS policies, and how migrations/seeds bypass them

### Policy definition

Enable and force RLS, then write policies that read the GUC. `current_setting('app.current_tenant', true)` returns `NULL` (not an error) when the GUC is unset, so a request that forgot to set context matches no rows — fail-closed ([PostgreSQL: admin functions](https://www.postgresql.org/docs/current/functions-admin.html)):

```sql
ALTER TABLE ticket ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket FORCE  ROW LEVEL SECURITY;   -- also bind the table owner (see below)

CREATE POLICY tenant_isolation ON ticket
  USING      (tenant_id = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant', true)::uuid);
```

- **`USING`** filters which existing rows are visible/updatable/deletable; a row is hidden when the expression is false *or null* ([PostgreSQL: CREATE POLICY](https://www.postgresql.org/docs/current/sql-createpolicy.html)).
- **`WITH CHECK`** validates new/updated rows on INSERT/UPDATE; false/null raises an error and aborts the command ([PostgreSQL: CREATE POLICY](https://www.postgresql.org/docs/current/sql-createpolicy.html)). Supplying both prevents a tenant from writing rows they couldn't read (e.g. inserting another tenant's `tenant_id`). If `WITH CHECK` is omitted, `USING` is reused for the check ([PostgreSQL: CREATE POLICY](https://www.postgresql.org/docs/current/sql-createpolicy.html)).
- With RLS enabled and **no matching policy**, PostgreSQL applies a **default-deny**: no rows visible or modifiable ([PostgreSQL: Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)).

### Who bypasses RLS (migrations & seeding)

Three mechanisms bypass policies, per PostgreSQL ([Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)):

1. **The table owner** is *"typically not subject to row security policies"* — unless you add `ALTER TABLE ... FORCE ROW LEVEL SECURITY`.
2. **Roles with `BYPASSRLS`** — *"Superusers and roles with the `BYPASSRLS` attribute always bypass the row security system."* `FORCE` does **not** override `BYPASSRLS`.
3. **Superusers** — always bypass.

So migrations and the seed script should simply **connect as the schema-owning / privileged role** (which bypasses RLS by owner status or `BYPASSRLS`), letting them create the two seed tenants' data without tripping policies. Runtime request traffic connects as a **separate restricted role** that is subject to RLS.

### Neon-specific role notes (the important trap)

Neon gives you **no real superuser**: *"you cannot … connect using the Postgres `superuser` account"* ([Neon: Manage roles](https://neon.com/docs/manage/roles)). Instead, roles created via the Neon Console/CLI/API are members of **`neon_superuser`**, which **includes `BYPASSRLS`** (for projects created after 2023-08-15) ([Neon: Manage roles](https://neon.com/docs/manage/roles)).

Consequence: the default connection string you get from Neon (e.g. `neondb_owner`) **silently bypasses every RLS policy**. Neon's own multi-tenant guidance is explicit: *"If the app uses the wrong role, RLS can be silently bypassed"*, and *"your connection string for app requests should always use the least-privileged role"* — keep the owner *"for migrations only and let the production queries run with the restricted role by default"* ([Neon: RLS for multi-tenant apps](https://neon.com/guides/rls-multi-tenant-apps)).

**Recommended role split for Nivara:**

| Role | Attributes | Used for | Connection |
|---|---|---|---|
| `neondb_owner` (default, `neon_superuser` → `BYPASSRLS`) | bypasses RLS | migrations, seeding, privileged jobs | **direct/unpooled** endpoint (`directUrl`) |
| `app_user` (created via SQL; **not** a `neon_superuser` member, **no** `BYPASSRLS`) | subject to RLS | all request-path queries | pooled `-pooler` endpoint |

A SQL-created role does **not** inherit `neon_superuser` and gets only basic public-schema privileges ([Neon: Manage roles](https://neon.com/docs/manage/roles)), so create `app_user`, grant it exactly the table privileges it needs, and point Prisma's runtime `DATABASE_URL` at it. Because `app_user` is not the table owner, `FORCE ROW LEVEL SECURITY` is belt-and-suspenders, but keep it — it protects you if the app ever connects as the owner by mistake.

---

## 4. Gotchas

- **Prepared statements through the pooler.** SQL-level `PREPARE`/`DEALLOCATE` are *"Never"* compatible with transaction pooling ([PgBouncer](https://www.pgbouncer.org/features.html)) and Neon lists them as unsupported on pooled connections ([Neon](https://neon.com/docs/connect/connection-pooling)). Prisma uses named prepared statements internally; for **PgBouncer < 1.21** add **`?pgbouncer=true`** to the pooled URL so Prisma adjusts its behavior, and note Prisma explicitly *recommends against* the flag on PgBouncer ≥ 1.21 ([Prisma: PgBouncer](https://www.prisma.io/docs/orm/prisma-client/setup-and-configuration/databases-connections/pgbouncer)). Symptom of getting this wrong: `prepared statement "s0" already exists` (SQLSTATE 42P05).
- **Migrations need a direct connection.** Prisma's Schema Engine *"does not support connection pooling with PgBouncer"*; set a separate **`directUrl`** (Neon's non-`-pooler` host) for `prisma migrate`/`db push` while `Client` uses the pooled URL ([Prisma: PgBouncer](https://www.prisma.io/docs/orm/prisma-client/setup-and-configuration/databases-connections/pgbouncer)). This dovetails with the role split: migrations = owner role on the direct endpoint.
- **`current_setting` missing-variable handling.** `current_setting('app.current_tenant')` **throws** if the GUC was never set; `current_setting('app.current_tenant', true)` returns **NULL** ([PostgreSQL: admin functions](https://www.postgresql.org/docs/current/functions-admin.html)). Always pass `true` in policies so an unset context fails closed (matches nothing) instead of erroring the query. Registering `app.current_tenant` as a customized GUC is not required — any `namespace.name` custom setting is accepted at runtime.
- **`SET LOCAL` can't bind its value.** Prefer `set_config('app.current_tenant', $1, true)` (parameterizable, injection-safe via Prisma tagged template). Reserve `$executeRawUnsafe('SET LOCAL ...')` for cases where you must, and only with a server-validated value ([Prisma: raw queries](https://www.prisma.io/docs/orm/prisma-client/using-raw-sql/raw-queries)).
- **Owner ≠ enforced by default.** Policies don't apply to the table owner unless `FORCE ROW LEVEL SECURITY` is set — and never apply to a `BYPASSRLS`/superuser role even with FORCE ([PostgreSQL: Row Security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)). The only reliable guarantee is: **runtime connects as a non-owner, non-`BYPASSRLS` role.**
- **The whole scheme collapses if any request-path connection skips the context.** Neon: *"you need to always make sure every connection (including jobs and tasks) sets the needed context or uses the correct restricted role, otherwise RLS can't protect your data."* ([Neon: RLS for multi-tenant apps](https://neon.com/guides/rls-multi-tenant-apps)). Centralize the `withTenant` wrapper so no route can forget it.

---

## Recommended pattern for Nivara Desk

1. **Two roles, two endpoints.** Migrations/seed → owner role (`neon_superuser`/`BYPASSRLS`) over Neon's **direct** endpoint via Prisma `directUrl`. Runtime → dedicated `app_user` (no `BYPASSRLS`) over the **pooled** `-pooler` endpoint (`?pgbouncer=true` if PgBouncer <1.21).
2. **Every table:** `ENABLE` + `FORCE ROW LEVEL SECURITY`, with `USING`/`WITH CHECK` policies on `current_setting('app.current_tenant', true)::uuid`.
3. **Every request:** a request-scoped `withTenant(prisma, tenantId, tx => …)` helper that opens a Prisma interactive `$transaction`, runs `SELECT set_config('app.current_tenant', ${tenantId}, true)` (bound param, transaction-local), then runs all queries on `tx`. `tenantId` comes from the validated JWT, never client input.
4. **Ports:** Spring uses a JDBC/Hibernate connection hook (`session.doWork` / `TransactionSynchronization.afterBegin`); FastAPI uses a SQLAlchemy `after_begin` listener — both calling `set_config('app.current_tenant', ?, true)`. The enforcement (RLS + `set_config`) lives entirely in SQL and is identical across all three stacks.

---

## Sources

- [PostgreSQL — SET](https://www.postgresql.org/docs/current/sql-set.html) — `SET LOCAL` is transaction-scoped; session `SET` persists for the whole session after commit.
- [PostgreSQL — System administration functions](https://www.postgresql.org/docs/current/functions-admin.html) — `current_setting(name, missing_ok)` returns NULL vs throws; `set_config(name, value, is_local=true)` = transaction-local SET.
- [PostgreSQL — CREATE POLICY](https://www.postgresql.org/docs/current/sql-createpolicy.html) — `USING` (visibility filter, null ⇒ hidden) vs `WITH CHECK` (write validation, null ⇒ error); USING reused for check if WITH CHECK omitted.
- [PostgreSQL — Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) — ENABLE/FORCE RLS; owner not subject by default; `BYPASSRLS`/superuser always bypass; default-deny with no policy.
- [PgBouncer — Features / pooling modes](https://www.pgbouncer.org/features.html) — transaction mode returns the server connection to the pool at transaction end; `SET`/`RESET`, `PREPARE`/`DEALLOCATE`, `LISTEN` marked "Never".
- [Prisma — Transactions](https://www.prisma.io/docs/orm/prisma-client/queries/transactions) — interactive `$transaction` runs all queries on one connection in one DB transaction.
- [Prisma — Raw queries](https://www.prisma.io/docs/orm/prisma-client/using-raw-sql/raw-queries) — `$executeRaw` tagged template parameterizes/escapes and uses prepared statements; `$executeRawUnsafe` for statements that can't be prepared (e.g. ALTER); injection warning.
- [Prisma — Client query extensions](https://www.prisma.io/docs/orm/prisma-client/client-extensions/query) — `$extends({ query: { $allModels: { $allOperations } } })` shape for wrapping operations.
- [Prisma — PgBouncer](https://www.prisma.io/docs/orm/prisma-client/setup-and-configuration/databases-connections/pgbouncer) — `?pgbouncer=true` for PgBouncer <1.21; Schema Engine needs a `directUrl`; `prepared statement "s0" already exists` symptom.
- [Neon — Connection pooling](https://neon.com/docs/connect/connection-pooling) — pooler is PgBouncer transaction mode; `-pooler` vs direct host; SET/RESET, LISTEN/NOTIFY, PREPARE unsupported on pooled connections; use direct for migrations/admin.
- [Neon — Manage roles](https://neon.com/docs/manage/roles) — no real superuser; Console/CLI/API roles are `neon_superuser` members with `BYPASSRLS`; SQL-created roles get only basic privileges.
- [Neon — RLS for multi-tenant apps](https://neon.com/guides/rls-multi-tenant-apps) — owner (BYPASSRLS) for migrations only, least-privileged role for app requests; `SET LOCAL app.tenant_id`/`set_config`; every connection must set context or RLS can't protect data.
