import { Injectable } from '@nestjs/common';
import { isUniqueViolation } from '../common/errors/prisma-errors';
import { Message, TicketSource } from '../generated/prisma/client';
import { OUTBOUND_DELIVERY_JOB } from '../integrations/job-kinds';
import { JobQueueService } from '../scheduler/job-queue.service';
import { slackTarget } from '../slack/slack-target';
import { TenantClient } from '../tenancy/tenancy.service';

/**
 * Where a Ticket's replies have to be delivered, if anywhere.
 *
 * A `null` route is by far the common case: a Ticket opened in the portal or the
 * widget is *already* where the customer is reading, so there is nothing to
 * deliver anywhere.
 */
export interface ReplyRoute {
  source: string;
  /** The destination as its own adapter spells one. Opaque outside that adapter. */
  target: string;
}

/**
 * A customer-visible Message, on its way out of Nivara.
 *
 * This is the seam between "something was said" and "an integration has work to
 * do", and its shape is what keeps `MessageService` free of Slack. That service
 * calls one method with a Message; what happens next is decided from the Ticket's
 * own columns, and the adapter that eventually does the work is chosen by a
 * string in a row rather than by an import.
 *
 * Two rules decide whether anything happens at all, and both are structural
 * rather than conditional in an adapter:
 *
 * **Notes never leave.** There is no path from `NoteService` to here — not a
 * flag, not a filter, not a check that could be got wrong. The internal thread
 * and the outbound pipe are connected by no code, which is the same argument the
 * two tables make and the same one the `:internal` room makes.
 *
 * **The customer's own words never bounce back.** A Message authored by a
 * `contact` is one this system *ingested* from the channel it would now deliver
 * to; posting it back would appear in the customer's own thread as an echo, and
 * would then be ingested again. That loop is closed here by author kind rather
 * than in the Slack adapter, because it is a property of the pipe rather than of
 * Slack: any future two-way channel has exactly the same hazard.
 *
 * What this file is *not* is channel-agnostic, and it is worth saying plainly
 * rather than implying otherwise: `routeFor` below reads two Slack-named columns
 * and names `slack` as the source, because Slack is the only channel a Ticket can
 * be reachable on today. The honest generalization is a registry of route
 * readers keyed by source — and it is deliberately not built yet, because a
 * registry with one entry is machinery that hides the single case it holds. The
 * second channel is what should force it, and the seam is `routeFor`: one
 * function, returning one type, called from one place.
 */
@Injectable()
export class OutboundDispatchService {
  constructor(private readonly queue: JobQueueService) {}

  /**
   * Records and queues the delivery of one Message, if it has anywhere to go.
   *
   * Rides the caller's transaction, on the terms `AuditService.record` and
   * `JobQueueService.enqueue` established: the delivery record, the job and the
   * Message commit together or not at all. The alternative is the dual-write
   * failure in both directions — a queued delivery for a Message that rolled
   * back, arriving as a handler that cannot find its own subject, or a Message
   * that committed with nothing scheduled to deliver it, which is a reply that
   * silently never leaves.
   *
   * The unique index on `(tenantId, messageId, target)` is what makes this safe
   * to reach twice. A duplicate is swallowed rather than raised: it means the
   * delivery is already recorded and already owed, and failing the Message's
   * transaction over it would refuse a reply because it was, if anything,
   * over-scheduled.
   */
  async dispatchIn(tx: TenantClient, message: Message): Promise<void> {
    // The customer's own words, ingested from the very place a delivery would
    // send them. See the class comment: this is the echo loop, closed at the pipe.
    if (message.authorKind === 'contact') return;

    const ticket = await tx.ticket.findUnique({
      where: { id: message.ticketId },
      select: { slackChannelId: true, slackThreadTs: true },
    });

    const route = routeFor(ticket);

    if (!route) return;

    try {
      await tx.outboundDelivery.create({
        data: {
          tenantId: message.tenantId,
          source: route.source,
          messageId: message.id,
          target: route.target,
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) return;

      throw error;
    }

    // The payload is a single id, as the queue's convention asks: the handler
    // re-reads the delivery, the Message and the Ticket inside a tenant context,
    // so it acts on the rows as they are rather than on a copy taken now.
    await this.queue.enqueue(tx, {
      kind: OUTBOUND_DELIVERY_JOB,
      payload: { messageId: message.id, target: route.target },
    });
  }
}

/**
 * The Ticket's reply route, read off its own columns.
 *
 * The one place a `source` string is chosen, and it is chosen from what the
 * Ticket actually carries rather than from `Ticket.source`. Those are different
 * questions and only one of them is answerable: `source` says where a Ticket
 * *originated*, which for a spawned Ticket may be a channel it can no longer be
 * reached on, whereas these columns say where it is reachable *now*. Routing on
 * the enum would deliver a spawned Ticket's replies into the void.
 */
const routeFor = (
  ticket: {
    slackChannelId: string | null;
    slackThreadTs: string | null;
  } | null,
): ReplyRoute | null => {
  if (!ticket?.slackChannelId || !ticket.slackThreadTs) return null;

  return {
    source: TicketSource.slack,
    target: slackTarget(ticket.slackChannelId, ticket.slackThreadTs),
  };
};
