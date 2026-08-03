import * as argon2 from 'argon2';
import { AuditAction, TicketPriority } from '../../src/generated/prisma/client';
import { SeedActor, armed, prisma } from './database';
import { TenantPlan, ThreadEntry, TicketPlan } from './plan';
import { SlaTarget, at, replay } from './sla';

/**
 * Turning a plan into rows, through the same doors the application uses.
 *
 * The temptation in a seed this size is to write the finished state directly:
 * insert a Ticket already `closed`, with its clocks filled in and its audit rows
 * composed by hand. Every trigger in this schema exists to make that impossible,
 * and they are right to — a Ticket that never entered the state machine has no
 * transition history, and a demo whose audit log is a fiction is worse than one
 * with no audit log.
 *
 * So this drives each Ticket through the machine: born `open`, triaged, then
 * transitioned one legal move at a time, with the actor armed for each so the
 * triggers stamp the truth. The one thing written directly afterwards is the SLA
 * clock, and only because the triggers anchor pause at `now()` — see
 * `backdateClocks`.
 */

/**
 * One password, shared by every seeded principal and printed on every run.
 *
 * The key-free demo path is the point: someone evaluating this API can sign in
 * without configuring an OAuth provider. It is safe to commit because it only
 * ever meets seeded `.test` accounts in a throwaway database — and it is long
 * enough to clear the sign-in DTO's twelve-character floor, so the demo
 * credentials are not a special case the validation has to bend for.
 */
export const SEED_PASSWORD = 'nivara-demo-password';

/**
 * Every seeded row that carries a password gets its own hash.
 *
 * argon2 salts each hash, so two principals sharing a password must not share a
 * stored value — otherwise the seed would demonstrate exactly the mistake the
 * storage format exists to prevent, in the artifact people read first.
 */
const hash = (): Promise<string> =>
  argon2.hash(SEED_PASSWORD, { type: argon2.argon2id });

export interface WriteOptions {
  /** The instant every offset in the plan is measured back from. */
  now: Date;

  /**
   * The stored form of each minted token, keyed by the id the plan gives it.
   * Raw values never come here.
   *
   * Keyed rather than positional so that the plan stays the thing that says
   * which credentials a tenant has: adding one is an entry in the plan and a
   * hash beside it, not a third argument every caller has to reorder.
   */
  tokenHashes?: Readonly<Record<string, string>>;
}

export const writeTenant = async (
  plan: TenantPlan,
  { now, tokenHashes }: WriteOptions,
): Promise<void> => {
  await prisma.tenant.create({
    data: {
      id: plan.id,
      slug: plan.slug,
      name: plan.name,
      widgetOrigins: [...plan.widgetOrigins],
    },
  });

  // Read back rather than restated. A trigger on `tenant` seeds the matrix, so
  // it is already the tenant's own answer, and a copy here would be a second
  // definition that could drift from the one the sweep compares against.
  const targets = await readTargets(plan.id);

  const admin = plan.users.find((user) => user.role === 'admin');

  if (!admin) throw new Error(`tenant ${plan.slug} has no admin to act as`);

  for (const user of plan.users) {
    await prisma.user.create({
      data: {
        id: user.id,
        tenantId: plan.id,
        email: user.email,
        name: user.name,
        role: user.role,
        passwordHash: await hash(),
        googleSubject: user.googleSubject ?? null,
      },
    });
  }

  for (const contact of plan.contacts) {
    await prisma.contact.create({
      data: {
        id: contact.id,
        tenantId: plan.id,
        email: contact.email,
        name: contact.name,
        verified: contact.verified,
        // A portal credential for the identified Contacts and none for the
        // anonymous one, which is the honest split rather than an oversight: a
        // Contact with no email is the widget-born case that has no way to sign
        // in, and giving it a password would hide that the portal refuses it.
        passwordHash: contact.email ? await hash() : null,
      },
    });
  }

  // Both or neither, per token, and loudly. A plan naming a token with no hash
  // to store would be a row nobody can present a credential for — and worse,
  // the caller has already minted the secret and is about to print it, so the
  // developer would be handed a credential that authenticates nothing. Keying
  // the hashes by id is what makes that reachable by a typo, so it throws here
  // rather than skipping quietly.
  for (const token of [plan.assistantToken, plan.reporterToken]) {
    if (!token) continue;

    const tokenHash = tokenHashes?.[token.id];

    if (!tokenHash) {
      throw new Error(
        `tenant ${plan.slug} plans a service token (${token.name}, ${token.id}) with no hash to store`,
      );
    }

    await armed(plan.id, { kind: 'user', id: admin.id }, async (tx) => {
      await tx.serviceToken.create({
        data: {
          id: token.id,
          tenantId: plan.id,
          name: token.name,
          tokenHash,
          scopes: [...token.scopes],
          createdById: admin.id,
        },
      });

      // The scopes go in `metadata` because they have nowhere else to live: the
      // row's own `scopes` column is mutable, and the question the log answers is
      // what the token was granted *at mint*.
      await tx.auditLog.create({
        data: {
          tenantId: plan.id,
          action: AuditAction.token_minted,
          targetKind: 'service_token',
          targetId: token.id,
          metadata: { scopes: [...token.scopes] },
        },
      });
    });
  }

  if (plan.slack) {
    await prisma.slackInstallation.create({
      data: {
        tenantId: plan.id,
        teamId: plan.slack.teamId,
        botUserId: plan.slack.botUserId,
      },
    });
  }

  // Oldest first, so a Ticket spawned from a closed predecessor finds it already
  // written — the linkage trigger reads the parent to derive the chain root.
  const chronological = [...plan.tickets].sort(
    (left, right) => right.openedDaysAgo - left.openedDaysAgo,
  );

  for (const ticket of chronological) {
    await writeTicket(plan, ticket, targets[ticket.priority], {
      now,
      adminId: admin.id,
      serviceTokenId: plan.assistantToken?.id,
    });
  }
};

interface TicketContext {
  now: Date;
  adminId: string;
  serviceTokenId?: string;
}

/**
 * The one translation from the plan's vocabulary to the database's.
 *
 * It is one function rather than a cascade at each write site because the
 * `ai → service` line is the whole mechanism behind deflection: a Ticket counts
 * as deflected precisely when no `user` authored anything on it, so an AI reply
 * written under a `user` actor would be a silently un-deflected Ticket with
 * nothing on the thread to explain why. A rule that load-bearing gets stated
 * once.
 *
 * `agent` resolves to the assignee where there is one and the tenant's admin
 * otherwise, which is the honest reading of an untriaged Ticket somebody
 * answered: work nobody owns is still done by someone.
 */
const actorFor = (
  by: 'contact' | 'agent' | 'ai',
  plan: TicketPlan,
  context: TicketContext,
): SeedActor => {
  if (by === 'contact') return { kind: 'contact', id: plan.contactId };
  if (by === 'ai') return { kind: 'service', id: context.serviceTokenId };

  return { kind: 'user', id: plan.assigneeId ?? context.adminId };
};

const writeTicket = async (
  tenant: TenantPlan,
  plan: TicketPlan,
  target: SlaTarget,
  context: TicketContext,
): Promise<void> => {
  const { now } = context;
  const openedAt = at(now, plan.openedDaysAgo);

  // Born `open`, `normal`, and unassigned — from the requester, because that is
  // who opened it. Every other shape the Ticket ends up in is reached by a move
  // the machine checked and the log recorded.
  await armed(tenant.id, actorFor('contact', plan, context), async (tx) => {
    await tx.ticket.create({
      data: {
        id: plan.id,
        tenantId: tenant.id,
        subject: plan.subject,
        contactId: plan.contactId,
        source: plan.source,
        spawnedFromTicketId: plan.spawnedFromTicketId ?? null,
        slackChannelId: plan.slackRoute?.channelId ?? null,
        slackThreadTs: plan.slackRoute?.threadTs ?? null,
        createdAt: openedAt,
        updatedAt: openedAt,
        lastActivityAt: openedAt,
      },
    });

    await tx.auditLog.create({
      data: {
        tenantId: tenant.id,
        action: AuditAction.ticket_created,
        targetKind: 'ticket',
        targetId: plan.id,
        ticketId: plan.id,
        toValue: 'open',
        createdAt: openedAt,
      },
    });
  });

  // Chronological, and that ordering is load-bearing rather than tidy: the
  // Message trigger sets `first_response_at` from the first customer-visible
  // reply it sees, so writing the thread out of order would date the response
  // clock from whichever reply happened to be inserted first.
  const thread = [...plan.thread].sort(
    (left, right) => right.daysAgo - left.daysAgo,
  );

  for (const entry of thread) {
    await writeThreadEntry(tenant, plan, entry, context);
  }

  // Triage as one update, which is what makes it one act in the log: two audit
  // rows, both stamped with the same admin, rather than a Ticket that was
  // assigned and prioritised by two apparently unrelated statements.
  if (plan.priority !== TicketPriority.normal || plan.assigneeId) {
    await armed(tenant.id, { kind: 'user', id: context.adminId }, (tx) =>
      tx.ticket.update({
        where: { id: plan.id },
        data: { priority: plan.priority, assigneeId: plan.assigneeId },
      }),
    );
  }

  for (const move of plan.path) {
    await armed(tenant.id, actorFor(move.by ?? 'agent', plan, context), (tx) =>
      tx.ticket.update({ where: { id: plan.id }, data: { state: move.to } }),
    );
  }

  await backdateClocks(tenant, plan, target, context, openedAt);
};

const writeThreadEntry = async (
  tenant: TenantPlan,
  plan: TicketPlan,
  entry: ThreadEntry,
  context: TicketContext,
): Promise<void> => {
  const createdAt = at(context.now, entry.daysAgo);

  await armed(tenant.id, actorFor(entry.by, plan, context), async (tx) => {
    const data = {
      tenantId: tenant.id,
      ticketId: plan.id,
      body: entry.body,
      createdAt,
    };

    // Author attribution is conspicuously absent from both inserts. It is
    // stamped by each table's own trigger from the armed context, so a seeded
    // Message cannot claim an author the transaction was not acting as — which
    // is the property deflection is counted on.
    if (entry.internal) await tx.note.create({ data });
    else await tx.message.create({ data });
  });
};

/**
 * The one place the seed writes state the machine would otherwise own.
 *
 * The pause accumulator is maintained by the transition trigger from `now()`,
 * which is correct for a live transition and useless for a replayed one: every
 * move this seed makes happens in the same second, so a Ticket that spent nine
 * days waiting on the customer would land with a few milliseconds of pause and a
 * pause that started this afternoon. The SLA demo would then be a queue where
 * nothing has ever been paused and everything is about to breach.
 *
 * So the clocks are computed from the plan's timeline by `replay()` — which
 * restates the trigger's own rules — and written afterwards. The two breach
 * latches go the same way and for a related reason: they are set-once, and the
 * sweep that would normally set them cannot reach into the past.
 *
 * Raw SQL because `updated_at` is Prisma's `@updatedAt` and would be overwritten
 * with the wall clock by any model-level write, leaving a fifty-day-old Ticket
 * that claims it was last touched during the seed.
 */
const backdateClocks = async (
  tenant: TenantPlan,
  plan: TicketPlan,
  target: SlaTarget,
  context: TicketContext,
  openedAt: Date,
): Promise<void> => {
  const clocks = replay({
    now: context.now,
    openedAt,
    path: plan.path,
    thread: plan.thread,
    target,
  });

  await armed(
    tenant.id,
    { kind: 'user', id: context.adminId },
    (tx) =>
      tx.$executeRaw`
      UPDATE "ticket"
         SET "sla_paused_ms" = ${BigInt(Math.round(clocks.pausedMs))},
             "sla_pause_started_at" = ${clocks.pauseStartedAt},
             "first_response_breached_at" = ${clocks.firstResponseBreachedAt},
             "resolution_breached_at" = ${clocks.resolutionBreachedAt},
             "last_activity_at" = ${clocks.lastActivityAt},
             "updated_at" = ${clocks.lastActivityAt}
       WHERE "id" = ${plan.id}::uuid
    `,
  );
};

/** The tenant's SLA matrix, as the seeding trigger left it. */
const readTargets = async (
  tenantId: string,
): Promise<Record<TicketPriority, SlaTarget>> => {
  const rows = await prisma.slaTarget.findMany({ where: { tenantId } });

  return Object.fromEntries(
    rows.map((row) => [
      row.priority,
      {
        firstResponseMs: Number(row.firstResponseMs),
        resolutionMs: Number(row.resolutionMs),
      },
    ]),
  ) as Record<TicketPriority, SlaTarget>;
};
