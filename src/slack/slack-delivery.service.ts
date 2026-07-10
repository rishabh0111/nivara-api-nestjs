import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { AuditAction, OutboundDelivery } from '../generated/prisma/client';
import { payloadString } from '../integrations/job-kinds';
import { parseSlackTarget } from './slack-target';
import { RealtimeService } from '../realtime/realtime.service';
import { JobContext, JobPayload } from '../scheduler/job-handler';
import { TenancyService, TenantClient } from '../tenancy/tenancy.service';
import { PermanentSlackError, SlackClient } from './slack-client';

/**
 * An agent's reply, getting to the customer.
 *
 * The `outbound.delivery` handler, and the piece where the queue's guarantees and
 * this table's guarantees have to be read together to see that the whole is
 * correct. The queue promises **at-least-once**: a process killed after posting
 * to Slack and before settling its row leaves a lease that expires and is handed
 * out again. On its own that means every hard restart double-posts into a
 * customer's thread.
 *
 * Two distinct things close that, and it is worth being exact about which covers
 * which, because they are easy to mistake for one guard doing both jobs.
 *
 * **A job that runs again after a settled success** is stopped by the claim
 * below: `delivered` no longer matches `status: 'pending'`, so the second run
 * finds the first run's evidence and posts nothing. This is the common case — a
 * crash between the post and the settle, a redelivered job, a duplicate dispatch.
 *
 * **Two handlers running at the same time** is stopped by the job's *lease*, not
 * by anything in this file. A second drainer may only claim a job whose lease has
 * expired, so two handlers overlap on one delivery exactly when the first is
 * still running past `LEASE_MS`. That is why `SlackClient` posts under a request
 * timeout well below the lease: it makes "still posting when the lease expires"
 * unreachable, which is what turns the lease into genuine mutual exclusion. The
 * claim below is *not* what provides it, and reading it as though it were would
 * be a mistake — it leaves the row `pending` throughout the post.
 *
 * The division of labour is worth stating plainly, because the temptation to
 * duplicate it is real: **the job owns retry, this row owns delivery.** Backoff,
 * attempt counting and giving up are `job` columns, identical for every kind of
 * externally fallible work; whether this particular reply has reached this
 * particular place is a fact only this table can hold. Reimplementing either one
 * on the other side would be two schedules that can disagree.
 *
 * Failure is **notify, don't mutate**, and that rule is what makes an integration
 * outage survivable. When delivery is finally given up, three things happen — the
 * row goes `dead`, an audit entry is appended under the `system` actor, and the
 * agents room is told — and not one of them touches the Ticket. Nothing is
 * reopened, escalated or flagged, because a broken adapter must not be able to
 * rewrite a tenant's queue, and an agent who is told their reply did not land can
 * decide what to do far better than a rule could.
 */
@Injectable()
export class SlackDeliveryService {
  private readonly logger = new Logger(SlackDeliveryService.name);

  constructor(
    private readonly tenancy: TenancyService,
    private readonly slack: SlackClient,
    private readonly audit: AuditService,
    private readonly realtime: RealtimeService,
  ) {}

  handle = async (payload: JobPayload, context: JobContext): Promise<void> => {
    const messageId = payloadString(payload, 'messageId');
    const target = payloadString(payload, 'target');

    const delivery = await this.claim(context.tenantId, messageId, target);

    // Already done. Either a redelivery of a job whose success was never settled,
    // or a second job for a Message somebody dispatched twice. Both are the
    // at-least-once window, and both end here rather than in the customer's
    // thread a second time.
    if (!delivery) return;

    const destination = parseSlackTarget(target);

    // A destination that does not parse cannot be reached by any number of
    // retries, so it is settled immediately rather than burning five attempts on
    // a string. It means the two halves of the target serialization have
    // disagreed, which is a bug in this repository rather than an outage.
    if (!destination) {
      await this.abandon(
        context,
        delivery,
        `The delivery target ${JSON.stringify(target)} is not a Slack destination.`,
      );

      return;
    }

    const text = await this.textOf(context.tx, delivery.messageId);

    // The Message is gone — the Ticket was deleted while this sat in the queue.
    // There is nothing left to deliver and nobody to tell about it, so this is
    // the one failure that is neither retried nor announced.
    if (text === null) {
      await this.settle(context.tx, delivery.id, {
        status: 'dead',
        lastError: 'The Message was deleted before it could be delivered.',
      });

      return;
    }

    try {
      const posted = await this.slack.postMessage({
        ...destination,
        text,
        // Read inside the tenant, which is the whole reason the credential is a
        // table of its own: by now the tenant is settled, so this is an ordinary
        // isolated read and no context in the system can reach another tenant's
        // token. `undefined` falls back to configuration, which is what a
        // single-workspace development run relies on.
        token: await this.tokenFor(context.tx),
      });

      // Recorded in its own transaction rather than the handler's, because the
      // handler's transaction is still open across the network call above — and
      // a transaction held open for the duration of a third party's latency is a
      // connection the HTTP surface cannot have.
      await this.record(context.tenantId, delivery.id, posted.ts);
    } catch (error) {
      await this.fail(context, delivery, error);
    }
  };

  /**
   * Takes the attempt, or reports that there is nothing to take.
   *
   * `updateMany` guarded on `status: 'pending'` rather than a read followed by a
   * write, so the test and the increment cannot disagree about a row that moved
   * between them.
   *
   * What this guard actually buys is one thing: a delivery that has already been
   * *settled* — `delivered` or `dead` — matches nothing, so a job that runs again
   * after a success whose settle was lost posts no second copy. It deliberately
   * does **not** provide mutual exclusion between two concurrent handlers; the
   * row stays `pending` for the whole of the post, so two overlapping runs would
   * both match. That case is excluded upstream, by the job lease and the request
   * timeout that keeps a handler inside it — see the class comment.
   *
   * The attempt counter increments here, at claim, for the reason the queue's
   * does: a handler killed mid-post writes no failure, so counting failures would
   * leave a delivery that reliably kills the process looking untried forever.
   *
   * In its own transaction rather than the handler's, and that is not tidiness.
   * The retry path below rethrows so the queue can schedule the next attempt, and
   * a throw rolls the handler's transaction back — so a claim riding it would be
   * undone by the very failure it was counting, and `attempts` would read zero
   * forever on a delivery that had been tried five times.
   */
  private async claim(
    tenantId: string,
    messageId: string,
    target: string,
  ): Promise<OutboundDelivery | null> {
    return this.inOwnTransaction(tenantId, async (tx) => {
      const { count } = await tx.outboundDelivery.updateMany({
        where: { messageId, target, status: 'pending' },
        data: { attempts: { increment: 1 } },
      });

      if (count === 0) return null;

      return tx.outboundDelivery.findFirst({ where: { messageId, target } });
    });
  }

  /**
   * This tenant's bot token, or `undefined` if the installation has none.
   *
   * `findFirst` without a filter because row-level security is the filter: the
   * armed context sees this tenant's rows and no others, and a tenant has one
   * installation. Writing a `where` clause here would restate the policy in
   * application code, which is the habit this codebase avoids — a forgotten
   * filter must return nothing rather than somebody else's secret.
   */
  private async tokenFor(tx: TenantClient): Promise<string | undefined> {
    const credential = await tx.slackCredential.findFirst({
      select: { botAccessToken: true },
    });

    return credential?.botAccessToken;
  }

  /** The body to post, or `null` if the Message no longer exists. */
  private async textOf(
    tx: TenantClient,
    messageId: string,
  ): Promise<string | null> {
    const message = await tx.message.findUnique({
      where: { id: messageId },
      select: { body: true },
    });

    return message?.body ?? null;
  }

  /**
   * Marks a delivery done, in a transaction of its own.
   *
   * The post has already happened by the time this runs, so the thing that must
   * not occur is this write being rolled back by anything later. Committing it on
   * its own means the evidence of a real post outlives whatever else the handler
   * goes on to do — and it is that evidence the next attempt's claim reads when
   * it declines to post a second copy.
   */
  private async record(
    tenantId: string,
    deliveryId: string,
    externalId: string,
  ): Promise<void> {
    await this.inOwnTransaction(tenantId, (tx) =>
      tx.outboundDelivery.update({
        where: { id: deliveryId },
        data: {
          status: 'delivered',
          deliveredAt: new Date(),
          externalId,
          lastError: null,
        },
      }),
    );
  }

  /**
   * A failed attempt: either back on the queue, or given up on.
   *
   * The decision is made from two things the drainer already knows — whether this
   * was the last attempt, and whether the error was one that waiting can fix — so
   * this handler runs no clock and holds no backoff of its own. Rethrowing hands
   * the retry back to the queue, which schedules it as a later `run_after` rather
   * than as a sleeping worker.
   *
   * A permanent error short-circuits the remaining attempts rather than exhausting
   * them. A bot that was removed from a channel will still be removed in five
   * minutes, and spending four more attempts to reach the same conclusion means
   * four more minutes of an agent believing their reply landed.
   */
  private async fail(
    context: JobContext,
    delivery: OutboundDelivery,
    error: unknown,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const permanent = error instanceof PermanentSlackError;
    const lastChance = context.attempt >= context.maxAttempts;

    if (permanent || lastChance) {
      await this.abandon(context, delivery, message);

      return;
    }

    // Back to `pending` so the next attempt can claim it, with the reason kept
    // for whoever reads the row. Committed on its own, because the rethrow on the
    // next line rolls the handler's transaction back — writing this there would
    // erase it with the same statement that reports it.
    await this.inOwnTransaction(context.tenantId, (tx) =>
      this.settle(tx, delivery.id, { status: 'pending', lastError: message }),
    );

    // The queue owns the schedule. Declining to raise here would tell the drainer
    // the delivery succeeded, and the reply would never be tried again.
    throw error;
  }

  /**
   * Giving up: record it, write it down, and tell somebody.
   *
   * Deliberately does *not* throw. Letting the error escape would dead-letter the
   * job as well, and the two would then be a single fact recorded in two places
   * that can disagree about it — with the audit row and the announcement below
   * rolled back by the very throw that was meant to report them. The `dead`
   * delivery row is where an operator looks; the job's business was retrying, and
   * it has finished retrying.
   *
   * The audit entry rides the handler's own transaction so that "we gave up" and
   * the record of having given up commit together. The socket emission comes
   * after, as every emission in this system does: an announcement must not
   * describe a state the database rolled back.
   */
  private async abandon(
    context: JobContext,
    delivery: OutboundDelivery,
    error: string,
  ): Promise<void> {
    const ticketId = await this.settleAndAudit(context, delivery, error);

    this.logger.error(
      `Gave up delivering message ${delivery.messageId} to ${delivery.source} ${delivery.target}: ${error}`,
    );

    // Nothing is announced for a Message whose Ticket no longer exists. The event
    // is addressed to a console showing a conversation, and there is no
    // conversation left to show it on — the `dead` row and the log line are the
    // whole record in that case, which is proportionate to a failure nobody can
    // act on.
    if (!ticketId) return;

    await this.realtime.integrationFailed(context.tenantId, {
      ticketId,
      messageId: delivery.messageId,
      source: delivery.source,
      target: delivery.target,
      error,
    });
  }

  private async settleAndAudit(
    context: JobContext,
    delivery: OutboundDelivery,
    error: string,
  ): Promise<string | null> {
    await this.settle(context.tx, delivery.id, {
      status: 'dead',
      lastError: error,
    });

    const message = await context.tx.message.findUnique({
      where: { id: delivery.messageId },
      select: { ticketId: true },
    });

    const ticketId = message?.ticketId ?? null;

    // The actor is stamped `system` by the database from the armed context — the
    // drainer arms it, and this call neither says so nor could. That is exactly
    // what makes "no human decided to abandon this" a fact rather than a claim.
    //
    // `integration` is the target kind, which the audit vocabulary reserved
    // before there was an integration to point at, and the target is the delivery
    // row rather than the Message: what failed is an attempt to reach somewhere,
    // and the Message itself is fine — it exists, it says what the agent typed,
    // and it is visible in the thread. `ticketId` is set alongside so the entry
    // lands on the Ticket's timeline, which is where an agent reading the
    // conversation will look for an explanation of the silence.
    await this.audit.record(context.tx, {
      action: AuditAction.integration_failed,
      targetKind: 'integration',
      targetId: delivery.id,
      ...(ticketId ? { ticketId } : {}),
      metadata: {
        source: delivery.source,
        target: delivery.target,
        messageId: delivery.messageId,
        attempts: delivery.attempts,
        error,
      },
    });

    return ticketId;
  }

  private async settle(
    tx: TenantClient,
    id: string,
    data: { status: 'pending' | 'dead'; lastError: string },
  ): Promise<void> {
    await tx.outboundDelivery.update({ where: { id }, data });
  }

  /**
   * A transaction that is not the drainer's.
   *
   * The `system` actor, because that is what the drainer arms and what this work
   * genuinely is: nobody asked for a delivery to be attempted at this instant.
   * Anything written under it — including the audit row a permanent failure
   * produces — is attributed to the system by the database rather than by this
   * class saying so.
   */
  private async inOwnTransaction<T>(
    tenantId: string,
    work: (tx: TenantClient) => Promise<T>,
  ): Promise<T> {
    return this.tenancy.withTenant(
      { tenantId, actor: { kind: 'system' } },
      work,
    );
  }
}
