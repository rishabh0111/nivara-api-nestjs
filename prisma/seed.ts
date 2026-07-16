import 'dotenv/config';
import { mintServiceToken } from '../src/service-tokens/service-token-format';
import { TENANT_IDS, TICKET_IDS } from './seed/anchors';
import { prisma, reset } from './seed/database';
import { meridian } from './seed/meridian';
import { TenantPlan } from './seed/plan';
import { sortwood } from './seed/sortwood';
import { SEED_PASSWORD, writeTenant } from './seed/write';

/**
 * The demo, from a clean clone and with no credentials of any kind.
 *
 * Two tenants: Meridian, which is showcase-rich, and Sortwood, which exists so
 * that isolation can be checked by hand rather than taken on trust. Each has its
 * own file; this one runs them and says what it made.
 *
 * The whole seed hangs on one instant. Every offset in both plans is expressed
 * as days before `now`, and `now` is captured once here — so a run that takes
 * ninety seconds does not produce a queue whose Tickets disagree with each other
 * about what time it is.
 *
 * It runs as the owner over the direct endpoint, which bypasses row-level
 * security. That is not a loophole: seeding two tenants is by definition work no
 * single tenant context could do, and resetting the database is work no tenant
 * context should be able to do at all.
 */

const main = async (): Promise<void> => {
  const now = new Date();

  await reset();

  // Minted here rather than inside the tenant plan, because the raw value must
  // exist in exactly two places — this variable and the console — and never in a
  // file anyone could commit. Only the hash reaches the database, so a developer
  // who loses the printout reseeds rather than recovering it: the same story the
  // mint endpoint tells a real admin.
  const token = mintServiceToken(TENANT_IDS.meridian);

  await writeTenant(meridian, { now, serviceTokenHash: token.tokenHash });
  await writeTenant(sortwood, { now });

  announce(token.raw);
};

/**
 * A tenant's size, counted from the plan rather than typed out beside it.
 *
 * The plan is the only thing that knows how big a tenant is, and a number
 * written next to it is a number that goes wrong the first time somebody adds a
 * Ticket. This is the one place the seed reports on itself, so it is the one
 * place that must not be able to lie.
 */
const scale = (plan: TenantPlan): string =>
  `${plan.name.padEnd(8)}  ${plan.id}  ` +
  `${String(plan.users.length).padStart(2)} staff, ` +
  `${String(plan.contacts.length).padStart(2)} contacts, ` +
  `${String(plan.tickets.length).padStart(2)} tickets`;

/**
 * What the run leaves the developer holding.
 *
 * Printed rather than written into a README, because half of it is a secret that
 * must not be committed and the rest is only true of this database. The anchored
 * ids are the exception and are quoted anyway, so the output stands on its own
 * without anybody having to go and look them up.
 */
const announce = (rawToken: string): void => {
  console.log(`
Seeded two tenants.

  ${scale(meridian)}  showcase
  ${scale(sortwood)}  isolation

Staff sign-in is POST /auth/sign-in with a tenant id, an address and a password.
Every seeded principal shares the password ${JSON.stringify(SEED_PASSWORD)}.

  admin@meridian.test   admin, Meridian
  agent@meridian.test   agent, Meridian
  admin@sortwood.test   admin, Sortwood
  dual@example.test     agent at Meridian, admin at Sortwood — one address in two
                        tenants, two Users, and neither login reaches the other

Contacts sign in at POST /portal/auth/sign-in with the same password:
jules@example.test (Meridian) and sam@example.test (Sortwood).

Reference Tickets, stable across reseeds:

  ${TICKET_IDS.breached}  past its first-response target
  ${TICKET_IDS.paused}  pending, resolution clock stopped
  ${TICKET_IDS.deflected}  answered and closed by the AI layer
  ${TICKET_IDS.reopened}  resolved, reopened, resolved again
  ${TICKET_IDS.closedWithSuccessor}  closed, with a linked successor

Meridian service token — shown once, stored only as a hash:

  ${rawToken}
`);
};

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
