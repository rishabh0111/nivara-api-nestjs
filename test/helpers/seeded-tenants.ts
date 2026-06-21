import { Client } from 'pg';

/**
 * Resolves the seeded tenants' ids, as the owner.
 *
 * The runtime role cannot do this, and that is not an oversight — reading a
 * tenant row requires a tenant context, and a tenant context requires the id.
 * (The application never has this problem: the id arrives on a validated
 * credential.) A test needs to see both tenants at once to demonstrate that
 * neither can see the other, so it takes the owner connection the seed used and
 * looks them up from outside the policy system entirely.
 */
export interface SeededTenants {
  meridian: string;
  sortwood: string;
}

export const seededTenantIds = async (): Promise<SeededTenants> => {
  const slugs = ['meridian', 'sortwood'];

  const connectionString = process.env['MIGRATE_DATABASE_URL'];

  if (!connectionString) {
    throw new Error(
      'MIGRATE_DATABASE_URL is required to run the integration tests: they read the seeded tenant ids as the owner. Start Postgres with `docker compose up -d postgres`, then `npm run db:migrate && npm run db:seed`.',
    );
  }

  const client = new Client({ connectionString });
  await client.connect();

  try {
    const { rows } = await client.query<{ id: string; slug: string }>(
      'SELECT id::text, slug FROM tenant WHERE slug = ANY($1)',
      [slugs],
    );

    const found = new Map(rows.map((row) => [row.slug, row.id]));
    const missing = slugs.filter((slug) => !found.has(slug));

    if (missing.length > 0) {
      throw new Error(
        `Seeded tenants missing: ${missing.join(', ')}. Run \`npm run db:seed\`.`,
      );
    }

    return {
      meridian: found.get('meridian')!,
      sortwood: found.get('sortwood')!,
    };
  } finally {
    await client.end();
  }
};
