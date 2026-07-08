import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { SlaBreachSnapshot } from '../realtime/events';
import { RealtimeService } from '../realtime/realtime.service';
import { Sweep } from '../scheduler/sweeper.service';
import { TenancyService, TenantClient } from '../tenancy/tenancy.service';
import { LatchedRow, latchedTimers } from './latched-timers';

/**
 * One latched breach, addressed to the room that will hear about it.
 *
 * The payload is the wire snapshot itself rather than its fields spread out
 * beside the tenant, so nothing between the `UPDATE` and the emit re-shapes it
 * — the only thing this wrapper adds is the one fact the snapshot deliberately
 * omits, which is who to tell.
 */
interface Breach {
  tenantId: string;
  breach: SlaBreachSnapshot;
}

/**
 * Notices missed deadlines, and tells the room.
 *
 * The scan is one `UPDATE … RETURNING` per tenant joined to that tenant's target
 * matrix. There is no lock around the tick, no "already escalated" flag, and no
 * de-duplication in the emit path; fire-once rests on two things instead, and it
 * is worth being precise about which does what.
 *
 * *Sequentially* — the case that actually happens, a tick every sixty seconds —
 * it is the `IS NULL` in the `WHERE` clause: the second statement's predicate no
 * longer matches the row the first one wrote, so it selects nothing and
 * announces nothing.
 *
 * *Concurrently* it is the set-once coercion in the state-machine trigger. Two
 * overlapping sweeps evaluate the `due` CTE from their own snapshots, so both
 * can reach the `UPDATE`; the trigger then coerces the second write back to the
 * value the first one latched, and since the emit is gated on the returned latch
 * equalling this sweep's own instant, the loser returns no timers and announces
 * nothing. The database ends single-latched either way.
 *
 * Latching and announcing are deliberately not symmetric about the transaction.
 * The latch and its audit row commit together, so history can never claim a
 * breach that rolled back; the socket emission happens after, because a delivery
 * failure must not undo a breach that genuinely occurred. That leaves the
 * at-least-once gap every emit in this system has, and the client's
 * reconnect-and-replay path is what covers it.
 *
 * Escalation is the whole of what happens next: a latch, an audit row, an event.
 * The Ticket's priority and assignee are untouched — bumping the priority would
 * retroactively change the target the Ticket is scored against, since priority
 * is the sole SLA key, and reassigning it would need a supervisor role that the
 * authorization model does not have.
 */
@Injectable()
export class SlaBreachSweep implements Sweep {
  readonly name = 'sla-breach';

  constructor(
    private readonly tenancy: TenancyService,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
  ) {}

  async run(now: Date): Promise<void> {
    // Tenant by tenant, each in its own armed transaction. The sweeper's
    // cross-tenant power stops at the list of ids: the Tickets are read and
    // written inside the same policies, the same triggers and the same audit
    // machinery as every request-driven write, which is what makes the sweep's
    // effects auditable by exactly the same rules.
    const breaches = await this.tenancy.forEachTenant((tx, tenantId) =>
      this.latchTenant(tx, tenantId, now),
    );

    // After every commit, for the reason every emit in this system is deferred:
    // an announcement must not describe a state the database rolled back, and a
    // socket failure must not undo a breach that genuinely occurred.
    for (const { tenantId, breach } of breaches) {
      await this.realtime.slaBreached(tenantId, breach);
    }
  }

  private async latchTenant(
    tx: TenantClient,
    tenantId: string,
    now: Date,
  ): Promise<Breach[]> {
    // Both predicates in one statement, so a Ticket that blew through both
    // targets is one row visited once rather than two scans of the same
    // table. The CTE names them rather than inlining them into the `SET`
    // and the `WHERE` both: written twice they could drift, and the `WHERE`
    // has to be the exact disjunction of the two — a looser prefilter would
    // rewrite rows whose latches then came back unchanged, which is a write
    // and a trigger firing to accomplish nothing.
    //
    // The two predicates read *different* elapsed figures, and that is the
    // one detail here worth slowing down for. First response is plain
    // wall-clock and never pauses: a Ticket moved to `pending` with nobody
    // having answered it is still a Ticket nobody has answered, and a clock
    // that stopped there would let a team discharge its response promise by
    // moving the Ticket instead of replying to it. Resolution reads the
    // pause-reduced figure, because time spent waiting on the customer is
    // genuinely not the team's to answer for.
    //
    // The first-response predicate therefore carries no state test — the
    // clock runs until somebody replies, wherever the Ticket sits. The
    // resolution predicate does test state, because "we still owe a
    // resolution" is a claim about where the Ticket is now.
    const rows = await tx.$queryRaw<LatchedRow[]>`
          WITH due AS (
            SELECT
              t."id" AS "id",
              (t."first_response_at" IS NULL
               AND t."first_response_breached_at" IS NULL
               AND e."wall_elapsed_ms" > s."first_response_ms") AS "first_response",
              (t."resolution_breached_at" IS NULL
               AND t."state" NOT IN ('resolved', 'closed')
               AND e."active_elapsed_ms" > s."resolution_ms") AS "resolution"
              FROM "ticket" t
              JOIN "sla_target" s
                ON s."tenant_id" = t."tenant_id"
               AND s."priority" = t."priority"
              CROSS JOIN LATERAL (
                SELECT
                  ticket_sla_wall_elapsed_ms(
                    t."created_at", ${now}::timestamptz
                  ) AS "wall_elapsed_ms",
                  ticket_sla_active_elapsed_ms(
                    t."created_at", t."sla_paused_ms",
                    t."sla_pause_started_at", ${now}::timestamptz
                  ) AS "active_elapsed_ms"
              ) e
             WHERE t."first_response_breached_at" IS NULL
                OR t."resolution_breached_at" IS NULL
          )
          UPDATE "ticket" t
             SET "first_response_breached_at" = CASE
                   WHEN due."first_response" THEN ${now}::timestamptz
                   ELSE t."first_response_breached_at"
                 END,
                 "resolution_breached_at" = CASE
                   WHEN due."resolution" THEN ${now}::timestamptz
                   ELSE t."resolution_breached_at"
                 END
            FROM due
           WHERE due."id" = t."id"
             AND (due."first_response" OR due."resolution")
          RETURNING
            t."id" AS "id",
            t."first_response_breached_at" AS "firstResponseBreachedAt",
            t."resolution_breached_at" AS "resolutionBreachedAt"
        `;

    const breaches: Breach[] = [];

    for (const row of rows) {
      for (const timer of latchedTimers(row, now)) {
        // One audit row per timer, in the same transaction as the latch that
        // permits it. `sla.breached` is one action with the timer in
        // `metadata` rather than two actions, because analytics reads the
        // latch columns directly and never needs to filter this table by
        // which clock ran out.
        //
        // The actor is stamped `system` by the database from the armed
        // context — this call does not and cannot say so, which is the
        // property that makes the attribution worth believing.
        await this.audit.record(tx, {
          action: 'sla_breached',
          targetKind: 'ticket',
          targetId: row.id,
          ticketId: row.id,
          metadata: { kind: timer },
        });

        breaches.push({
          tenantId,
          breach: {
            ticketId: row.id,
            timer,
            breachedAt: now.toISOString(),
          },
        });
      }
    }

    return breaches;
  }
}
