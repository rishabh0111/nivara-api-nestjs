import { Injectable, Logger } from '@nestjs/common';
import { ContactPrincipal } from '../auth/request-principal';
import { ContactReplyService } from '../conversation/contact-reply.service';
import { MessageService } from '../conversation/message.service';
import { Ticket, TicketSource } from '../generated/prisma/client';
import { payloadString } from '../integrations/job-kinds';
import { JobContext, JobPayload } from '../scheduler/job-handler';
import { TenancyService, TenantClient } from '../tenancy/tenancy.service';
import { TicketService } from '../tickets/ticket.service';
import { RealtimeService } from '../realtime/realtime.service';
import { readSlackMessage, SlackMessage } from './slack-event';
import { subjectFrom } from './slack-subject';

/**
 * A verified Slack event, becoming support work.
 *
 * This runs on the queue rather than on the request, so everything expensive or
 * fallible happens here: resolving a Contact, opening a Ticket, appending to a
 * thread, announcing all of it. The endpoint that accepted the event has already
 * gone.
 *
 * Its defining property is that it writes nothing Slack-specific of its own. A
 * top-level message opens a Ticket through `TicketService`; a thread reply goes
 * through `ContactReplyService`, which is the same path a portal reply takes and
 * therefore already knows that a reply to a `pending` Ticket reopens it, that a
 * reply to a `closed` one spawns a linked Ticket with a fresh clock, and that a
 * chain holds at most one live Ticket. None of that is re-decided here, which is
 * the point: a Slack customer and a portal customer get the same product because
 * they run the same code, not because two implementations were kept in step.
 *
 * The actor is the Contact, never `system` and never the tenant's staff. The
 * drainer arms `system` for the transaction it hands over — correct for a queue,
 * wrong for this — so every domain write below opens its own transaction from a
 * `ContactPrincipal`. That is what makes the Message's stamped author the
 * customer, which in turn is what makes the first-response clock, the deflection
 * metric and the audit trail tell the truth about a conversation that arrived
 * through a robot.
 */
@Injectable()
export class SlackIngestionService {
  private readonly logger = new Logger(SlackIngestionService.name);

  constructor(
    private readonly tenancy: TenancyService,
    private readonly tickets: TicketService,
    private readonly messages: MessageService,
    private readonly replies: ContactReplyService,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * The `inbound.event` handler.
   *
   * Throwing is the only failure signal the drainer reads, so anything that is
   * merely *not for us* returns quietly: an event this adapter ignores is not a
   * failure to retry, and dead-lettering one would fill the queue's error state
   * with Slack's ordinary traffic.
   *
   * Idempotence, as the queue requires of every handler, comes from two places
   * and it is worth being exact about which covers what. Slack's own
   * redeliveries never reach here at all — they lose the `event_id` claim at
   * ingest. What is left is the queue's own at-least-once window: a process
   * killed between a committed domain write and the settling of its job row. The
   * `opens` path is guarded against that by the thread lookup below, which finds
   * the Ticket the previous attempt created and takes the reply path instead of
   * opening a second one. The reply path would append the same sentence twice,
   * and that residual is accepted rather than hidden: it needs a hard kill inside
   * a millisecond window, and the alternative — a per-message dedupe column — is
   * a schema-wide cost for a duplicate line in a thread.
   */
  handle = async (payload: JobPayload, context: JobContext): Promise<void> => {
    const message = readSlackMessage(
      payload['event'],
      payloadString(payload, 'botUserId'),
    );

    if (message.kind === 'ignored') return;

    // Resolved under `system`, and deliberately so. Nobody asked for this Contact
    // to exist — the system created it on seeing a stranger speak — and it is the
    // one write on this path that is genuinely the server's own act.
    const contactId = await this.contactFor(
      context.tenantId,
      message.slackUserId,
    );

    const principal: ContactPrincipal = {
      kind: 'contact',
      tenantId: context.tenantId,
      contactId,
    };

    // The thread decides everything, and it is looked up rather than inferred
    // from whether Slack called this a reply. A `replies` event whose thread we
    // have never seen — the bot was invited to a channel mid-conversation, or the
    // opening message was ignored for having no text — has no Ticket to append
    // to, and opening one is a better answer than dropping a customer who is
    // asking for help.
    const existing = await this.ticketOnThread(
      principal,
      message.channelId,
      message.threadTs,
    );

    if (existing) {
      await this.appendTo(principal, existing, message.text);

      return;
    }

    await this.open(principal, message);
  };

  /**
   * The Contact behind a Slack account, created if this is the first time they
   * have spoken.
   *
   * An upsert on `(tenantId, slackUserId)`, which is the whole of cross-message
   * identity here: the same person's third question lands on the Contact their
   * first one created, so an agent sees a history rather than three strangers.
   *
   * `verified` stays false. Slack asserted this identity and we did not — the
   * same claim the widget makes about an anonymous visitor — and no email is
   * captured, because matching Contacts by email across channels would quietly
   * resolve the identity-merge seam ADR-0001 leaves deliberately open.
   *
   * `update: {}` rather than a no-op guard: the upsert exists to be race-safe,
   * and there is genuinely nothing to change about a Contact we already have.
   */
  private async contactFor(
    tenantId: string,
    slackUserId: string,
  ): Promise<string> {
    const contact = await this.tenancy.withTenant(
      { tenantId, actor: { kind: 'system' } },
      (tx) =>
        tx.contact.upsert({
          where: { tenantId_slackUserId: { tenantId, slackUserId } },
          create: { tenantId, slackUserId, verified: false },
          update: {},
          select: { id: true },
        }),
    );

    return contact.id;
  }

  /**
   * The live Ticket on a Slack thread, or the newest one if the conversation is
   * finished.
   *
   * Two reads rather than one, and the order is the interesting part. The live
   * Ticket is what a reply almost always belongs on, and
   * `ticket_one_live_per_slack_thread` makes it unique — so that read is exact
   * rather than a newest-first guess. Only when a chain is entirely closed does
   * the second read matter, and then the newest closed Ticket is the right anchor
   * because it is the one whose reply spawns the continuation.
   */
  private async ticketOnThread(
    principal: ContactPrincipal,
    channelId: string,
    threadTs: string,
  ): Promise<Ticket | null> {
    return this.tenancy.withTenant(
      {
        tenantId: principal.tenantId,
        actor: { kind: 'contact', id: principal.contactId },
      },
      async (tx) => {
        const route = { slackChannelId: channelId, slackThreadTs: threadTs };

        return (
          (await tx.ticket.findFirst({
            where: { ...route, state: { not: 'closed' } },
          })) ??
          (await tx.ticket.findFirst({
            where: route,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          }))
        );
      },
    );
  }

  /**
   * A reply on a thread that already has a Ticket.
   *
   * Straight through `ContactReplyService`, with `slack` as the channel the reply
   * arrived on rather than the channel the parent started on — the distinction
   * that keeps source analytics honest, and one that happens to be invisible here
   * because for a threaded conversation the two always agree.
   *
   * Everything that makes a reply interesting is decided in there: reopening a
   * `pending` Ticket, spawning a linked one off a `closed` Ticket, joining the
   * chain's existing live Ticket when two replies race. This method's whole job
   * is to not have opinions about any of it.
   */
  private async appendTo(
    principal: ContactPrincipal,
    ticket: Ticket,
    text: string,
  ): Promise<void> {
    await this.replies.reply(principal, ticket.id, text, TicketSource.slack);
  }

  /**
   * A new conversation: the Ticket and its first Message, together.
   *
   * One transaction, for the reason `ContactReplyService` gives about spawns — a
   * Ticket that committed without its first Message is a thread born empty, whose
   * first-response clock measures from nothing and whose queue entry tells an
   * agent that somebody wants something unspecified.
   *
   * The announcements come after the commit and in the order a console applies
   * them: the Ticket, then the Message on it. Reversed, a dashboard would be
   * asked to render an entry on a Ticket it has never heard of.
   */
  private async open(
    principal: ContactPrincipal,
    message: Extract<SlackMessage, { kind: 'opens' | 'replies' }>,
  ): Promise<void> {
    const opened = await this.tenancy.withTenant(
      {
        tenantId: principal.tenantId,
        actor: { kind: 'contact', id: principal.contactId },
      },
      async (tx: TenantClient) => {
        const ticket = await this.tickets.createIn(tx, principal, {
          subject: subjectFrom(message.text),
          contactId: principal.contactId,
          source: TicketSource.slack,
          // The reply path, carried on the Ticket from the moment it exists.
          // Every customer-visible Message posted here from now on goes back to
          // this thread, and a spawn off this Ticket inherits the route from the
          // database rather than from a call site.
          slackRoute: {
            channelId: message.channelId,
            threadTs: message.threadTs,
          },
        });

        return {
          ticket,
          message: await this.messages.postIn(
            tx,
            principal,
            ticket.id,
            message.text,
          ),
        };
      },
    );

    this.logger.log(
      `Opened Ticket ${opened.ticket.id} from Slack thread ${message.channelId}/${message.threadTs}`,
    );

    await this.realtime.ticketCreated(opened.ticket);
    await this.realtime.messageCreated(opened.message);
  }
}
