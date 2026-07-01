import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import * as argon2 from 'argon2';
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

/**
 * One password, shared by every seeded staff member, printed on every run.
 *
 * The key-free demo path is the point: someone evaluating this API can sign in
 * without configuring an OAuth provider. It is safe to commit because it only
 * ever meets seeded `.test` accounts in a throwaway database — and it is long
 * enough to clear the sign-in DTO's twelve-character floor, so the demo
 * credentials are not a special case the validation has to bend for.
 */
const SEED_PASSWORD = 'nivara-demo-password';

const SEED = {
  meridian: {
    slug: 'meridian',
    name: 'Meridian',
    users: [
      { email: 'admin@meridian.test', name: 'Ada Okonjo', role: 'admin' },
      { email: 'agent@meridian.test', name: 'Ravi Menon', role: 'agent' },
      // Deliberately the same address as a Sortwood User below. Tenant-local
      // identity (ADR-0001) is only demonstrable if some address actually
      // exists in two tenants: these are two Users, two rows, two passwords,
      // and neither login can reach the other.
      { email: 'dual@example.test', name: 'Iris Vance', role: 'agent' },
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
      // The other half of the shared-address pair. `admin` here, `agent` at
      // Meridian — so a login that resolved the wrong row would be visible in
      // the role it handed back, not just in the id.
      { email: 'dual@example.test', name: 'Iris Vance', role: 'admin' },
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

  // Hashed per tenant rather than once for the whole seed: argon2 salts each
  // hash, so two Users sharing a password must not share a hash — otherwise
  // the seed would demonstrate exactly the mistake the storage format exists
  // to prevent.
  for (const user of spec.users) {
    const passwordHash = await argon2.hash(SEED_PASSWORD, {
      type: argon2.argon2id,
    });

    await prisma.user.upsert({
      where: { tenantId_email: { tenantId: tenant.id, email: user.email } },
      update: { name: user.name, role: user.role, passwordHash },
      create: { tenantId: tenant.id, ...user, passwordHash },
    });
  }

  for (const contact of spec.contacts) {
    // A portal credential for the identified Contacts and none for the
    // anonymous one, which is the honest split rather than a convenience: a
    // Contact with no email is exactly the widget-born case that has no way to
    // sign in, and seeding it a password would hide that the portal refuses it.
    const passwordHash = contact.email
      ? await argon2.hash(SEED_PASSWORD, { type: argon2.argon2id })
      : null;

    // The anonymous Contact has no email, so there is no natural key to upsert
    // on — Postgres treats NULLs as distinct and re-running would pile up
    // duplicates. Match on "this tenant's emailless contact" instead.
    const existing = await prisma.contact.findFirst({
      where: { tenantId: tenant.id, email: contact.email },
    });

    if (existing) {
      await prisma.contact.update({
        where: { id: existing.id },
        data: { name: contact.name, verified: contact.verified, passwordHash },
      });
      continue;
    }

    await prisma.contact.create({
      data: { tenantId: tenant.id, ...contact, passwordHash },
    });
  }

  console.log(`Seeded tenant ${spec.slug} (${tenant.id})`);
};

const main = async (): Promise<void> => {
  for (const spec of Object.values(SEED)) {
    await seedTenant(spec);
  }

  // Printed rather than documented in a README that would drift: signing in
  // needs the tenant's id, and only this run knows it.
  console.log(
    `\nSign in at POST /auth/sign-in with any seeded staff address and password ${JSON.stringify(SEED_PASSWORD)}, quoting the tenant id printed above.` +
      `\nThe portal is POST /portal/auth/sign-in, with a seeded Contact address (jules@example.test, sam@example.test) and the same password.`,
  );
};

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
