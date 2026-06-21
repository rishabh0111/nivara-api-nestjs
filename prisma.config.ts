import 'dotenv/config';
import { defineConfig } from 'prisma/config';

/**
 * Configuration for the Prisma CLI — migrations and seeding only.
 *
 * It deliberately reads `MIGRATE_DATABASE_URL`, not `DATABASE_URL`. The CLI is
 * the one caller that is *supposed* to bypass row-level security: it creates
 * tables and seeds two tenants' worth of rows, neither of which any policy
 * would permit. So it connects as the owner over the direct (unpooled)
 * endpoint, while the running application connects as the non-BYPASSRLS
 * `app_user` over the pooled one.
 *
 * Keeping the two on separate variable names is what makes the split
 * enforceable: the deployed runtime's environment carries `DATABASE_URL` alone,
 * so there is no owner credential in the process for anything to reach for.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'ts-node prisma/seed.ts',
  },
  datasource: {
    url: process.env['MIGRATE_DATABASE_URL'],
  },
});
