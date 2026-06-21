import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';

/**
 * Two tenants, from the first migration onward.
 *
 * One tenant makes isolation unfalsifiable: every query returns the only rows
 * that exist, and a policy that did nothing at all would look identical to one
 * that worked. Meridian and Sortwood exist so that isolation can be
 * demonstrated rather than asserted — the tests in `test/tenancy.int-spec.ts`
 * ask Meridian's context for Sortwood's rows and get nothing back.
 *
 * Both tenants stay deliberately thin here. The showcase-scale seed — tickets,
 * threads, SLA clocks — belongs to the ticket that introduces those entities.
 *
 * This runs as the owner over the direct endpoint, which bypasses row-level
 * security. That is not a loophole: seeding two tenants is by definition work no
 * single tenant context could do.
 */

const SEED = {
  meridian: {
    slug: 'meridian',
    name: 'Meridian',
    users: [
      { email: 'admin@meridian.test', name: 'Ada Okonjo', role: 'admin' },
      { email: 'agent@meridian.test', name: 'Ravi Menon', role: 'agent' },
    ],
    contacts: [
      { email: 'jules@example.test', name: 'Jules Ferrand', verified: true },
      { email: null, name: null, verified: false },
    ],
  },
  sortwood: {
    slug: 'sortwood',
    name: 'Sortwood',
    users: [
      { email: 'admin@sortwood.test', name: 'Petra Lindqvist', role: 'admin' },
    ],
    contacts: [
      { email: 'sam@example.test', name: 'Sam Whitlock', verified: true },
    ],
  },
} as const;

const prisma = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: process.env['MIGRATE_DATABASE_URL'],
  }),
});

const seedTenant = async (
  spec: (typeof SEED)[keyof typeof SEED],
): Promise<void> => {
  // Keyed on the natural key so re-running the seed is a no-op rather than a
  // unique-constraint failure — compose runs it on every `up`.
  const tenant = await prisma.tenant.upsert({
    where: { slug: spec.slug },
    update: { name: spec.name },
    create: { slug: spec.slug, name: spec.name },
  });

  for (const user of spec.users) {
    await prisma.user.upsert({
      where: { tenantId_email: { tenantId: tenant.id, email: user.email } },
      update: { name: user.name, role: user.role },
      create: { tenantId: tenant.id, ...user },
    });
  }

  for (const contact of spec.contacts) {
    // The anonymous Contact has no email, so there is no natural key to upsert
    // on — Postgres treats NULLs as distinct and re-running would pile up
    // duplicates. Match on "this tenant's emailless contact" instead.
    const existing = await prisma.contact.findFirst({
      where: { tenantId: tenant.id, email: contact.email },
    });

    if (existing) {
      await prisma.contact.update({
        where: { id: existing.id },
        data: { name: contact.name, verified: contact.verified },
      });
      continue;
    }

    await prisma.contact.create({ data: { tenantId: tenant.id, ...contact } });
  }

  console.log(`Seeded tenant ${spec.slug} (${tenant.id})`);
};

const main = async (): Promise<void> => {
  for (const spec of Object.values(SEED)) {
    await seedTenant(spec);
  }
};

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
