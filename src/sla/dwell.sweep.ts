import { Injectable } from '@nestjs/common';
import { Permission } from '../authz/permissions';
import { Ticket, TicketState } from '../generated/prisma/client';
import { RealtimeService } from '../realtime/realtime.service';
import { Sweep } from '../scheduler/sweeper.service';
import { TenancyService, TenantClient } from '../tenancy/tenancy.service';
import { canTransition } from '../tickets/state-machine';

/**
 * What the scheduler is allowed to do to a Ticket.
 *
 * The dwell timers move Tickets with nobody behind them, and `canTransition`
 * takes a permission set rather than a role precisely so that this case has an
 * answer — the alternative would have been a second authorization path that
 * exists only for the scheduler and is therefore only ever reviewed once.
 *
 * Two permissions, and the list is a claim worth reading as one: the system may
 * settle abandoned work and may close what it settled, and it may do nothing
 * else. It cannot assign, cannot reprioritise, and cannot delete — which is the
 * same "notify, don't mutate" line the breach sweep holds, drawn where these two
 * timers genuinely need to cross it.
 */
export const SCHEDULER_PERMISSIONS: ReadonlySet<Permission> = new Set([
  'ticket:transition',
  'ticket:close',
]);

/** One dwell timer: a state that settles into another after seven days of silence. */
interface DwellTimer {
  from: TicketState;
  to: TicketState;
}

/**
 * The two timers, in the order a Ticket meets them.
 *
 * `pending → resolved` and then `resolved → closed`, which is why running both
 * in one pass is safe rather than a hazard: the first sets `last_activity_at` to
 * now, so a Ticket the first timer just resolved is seven days short of the
 * second and cannot be swept twice in the same tick down to `closed`.
 */
const TIMERS: DwellTimer[] = [
  // Silence on a Ticket waiting for the customer is an answer: they got what
  // they needed, or they moved on. Either way it is resolved rather than
  // abandoned in a queue nobody reads.
  { from: 'pending', to: 'resolved' },
  // And a resolution nobody disputed for a week is one that held. This is the
  // only path to `closed` that no human walks — which is why it is the timer
  // that has to be right, since `closed` is terminal and a later reply spawns a
  // fresh Ticket rather than reviving this one.
  { from: 'resolved', to: 'closed' },
];

/**
 * Abandoned work, settling itself.
 *
 * Fire-once here is not a latch but the from-to guard in the `WHERE` clause: a
 * Ticket the first statement moved out of `pending` no longer matches
 * `state = 'pending'`, so a second run in the same second finds nothing. That is
 * the same shape as the breach latch and it is deliberate — both sweeps rest on
 * a predicate that the effect itself falsifies, so neither needs a lock and both
 * survive two schedulers running at once.
 *
 * Emission is gated on `RETURNING`. A tick that changed nothing announces
 * nothing, which is what makes it safe to run this every sixty seconds forever
 * against a table where most days nothing dwells.
 *
 * The audit rows are not written here and their absence from this file is the
 * point: the state-machine trigger emits a `ticket.transitioned` row for every
 * transition through every write path, and the actor is stamped `system` from
 * the armed context. A sweep that logged its own transitions would be a second
 * source of those rows, and the first duplicate would be found in the timeline.
 */
@Injectable()
export class DwellSweep implements Sweep {
  readonly name = 'dwell';

  constructor(
    private readonly tenancy: TenancyService,
    private readonly realtime: RealtimeService,
  ) {}

  async run(now: Date): Promise<void> {
    const settled = await this.tenancy.forEachTenant(async (tx) => {
      const moved: Ticket[] = [];

      // Both timers inside one transaction per tenant, so a Ticket cannot be
      // observed resolved-but-not-yet-considered-for-closing by anything reading
      // between them.
      for (const timer of TIMERS) {
        moved.push(...(await this.settle(tx, timer, now)));
      }

      return moved;
    });

    // After the commit, for the reason every other emit in this system is: an
    // announcement must not describe a state the database rolled back, and a
    // socket failure must not undo a transition that already succeeded.
    for (const ticket of settled) {
      await this.realtime.ticketUpdated(ticket);
    }
  }

  private async settle(
    tx: TenantClient,
    timer: DwellTimer,
    now: Date,
  ): Promise<Ticket[]> {
    // Asked, not assumed. The transition table lives in the database and the
    // authority question lives in `canTransition`, and the scheduler is subject
    // to the second exactly as a request is — a timer whose destination it had
    // no permission to reach should stop here rather than at a policy error.
    if (!canTransition(timer.from, timer.to, SCHEDULER_PERMISSIONS)) {
      throw new Error(
        `dwell sweep: the scheduler may not move a Ticket to ${timer.to}`,
      );
    }

    // Raw, because the from-to guard has to be *in* the statement. Reading the
    // dwelling ids and then updating them by id would open a window in which an
    // agent replies between the two, and the sweep would resolve a Ticket that
    // is no longer silent.
    //
    // `ticket_dwell_window()` rather than a literal: the window is a product
    // decision shared by both timers, and a reader asking what it currently is
    // should not have to find two query strings and check they agree.
    const rows = await tx.$queryRaw<{ id: string }[]>`
      UPDATE "ticket"
         SET "state" = ${timer.to}::"ticket_state"
       WHERE "state" = ${timer.from}::"ticket_state"
         AND "last_activity_at" < ${now}::timestamptz - ticket_dwell_window()
      RETURNING "id"
    `;

    if (rows.length === 0) return [];

    // Re-read for the announcement rather than `RETURNING *`. The event carries
    // a full snapshot and a raw row would arrive with snake-case columns and
    // driver-typed values, so it would need a hand-written mapper that then has
    // to be kept in step with the model — inside the same transaction, this is
    // the same rows with none of that.
    return tx.ticket.findMany({ where: { id: { in: rows.map((r) => r.id) } } });
  }
}
