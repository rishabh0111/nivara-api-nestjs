import { Client, QueryResultRow } from 'pg';

/**
 * Reaching the database as the owner, from outside the policy system.
 *
 * The privileged connection is the point rather than a convenience. Every
 * guarantee this schema makes — tenant isolation, append-only history, the
 * ticket state machine — is meant to hold against a caller that outranks the
 * application, because the application is only one of three ports that will run
 * against this database. A rule the runtime role cannot break but the owner can
 * is not enforced, it is merely respected, and only a connection like this one
 * can tell the two apart.
 *
 * It is also how a test reads ids the application deliberately cannot: a tenant
 * context arrives on a credential rather than being looked up, so resolving two
 * tenants' rows at once — which is exactly what proving isolation requires — has
 * to happen from outside the policies entirely.
 */

/** The context a statement runs under, as `withTenant()` would have armed it. */
export interface ArmedAs {
  tenantId: string;
  actorKind: 'user' | 'contact' | 'service' | 'system';
  /** Empty for `system`, which has no row to point at. */
  actorId?: string;
}

/** A query as the owner, with no context armed at all. */
export async function asOwner<T extends QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return withOwnerClient((client) =>
    client.query<T>(sql, params).then(({ rows }) => rows),
  );
}

/**
 * A query as the owner, inside a transaction with the context settings armed.
 *
 * Hand-rolling what `withTenant()` does, rather than calling it, because the
 * tests that need this are about what the *database* does with those settings —
 * including the cases the application's own path makes unreachable, like an
 * insert that names an actor of its own. Arming and querying are separate
 * statements on one connection: `set_config(..., true)` is transaction-local,
 * and a bound parameter forces the extended query protocol, which will not
 * accept two statements in one string.
 */
export async function asOwnerArmed<T extends QueryResultRow>(
  armed: ArmedAs,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  return withOwnerClient(async (client) => {
    await client.query('BEGIN');

    try {
      await client.query(
        `SELECT set_config('app.current_tenant', $1, true),
                set_config('app.current_actor_kind', $2, true),
                set_config('app.current_actor_id', $3, true)`,
        [armed.tenantId, armed.actorKind, armed.actorId ?? ''],
      );

      const { rows } = await client.query<T>(sql, params);

      await client.query('COMMIT');

      return rows;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

/** A seeded Contact's id, by the email the seed gave it. */
export const contactOf = (tenantId: string, email: string): Promise<string> =>
  idOf('contact', tenantId, email);

/** A seeded User's id, by the email the seed gave it. */
export const userOf = (tenantId: string, email: string): Promise<string> =>
  idOf('"user"', tenantId, email);

async function idOf(
  table: string,
  tenantId: string,
  email: string,
): Promise<string> {
  const rows = await asOwner<{ id: string }>(
    `SELECT id::text FROM ${table} WHERE tenant_id = $1 AND email = $2`,
    [tenantId, email],
  );

  if (rows.length === 0) {
    throw new Error(
      `Seeded ${table} ${email} is missing from tenant ${tenantId}. Run \`npm run db:seed\`.`,
    );
  }

  return rows[0].id;
}

async function withOwnerClient<T>(
  work: (client: Client) => Promise<T>,
): Promise<T> {
  const connectionString = process.env['MIGRATE_DATABASE_URL'];

  if (!connectionString) {
    throw new Error(
      'MIGRATE_DATABASE_URL is required to run the integration tests. Start Postgres with `docker compose up -d postgres`, then `npm run db:migrate && npm run db:seed`.',
    );
  }

  const client = new Client({ connectionString });
  await client.connect();

  try {
    return await work(client);
  } finally {
    await client.end();
  }
}
