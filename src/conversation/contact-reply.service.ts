import { Injectable } from '@nestjs/common';
import { ContactPrincipal, tenantContextFor } from '../auth/request-principal';
import { AppException } from '../common/errors/app-exception';
import {
  Message,
  Ticket,
  TicketSource,
  TicketState,
} from '../generated/prisma/client';
import { RealtimeService } from '../realtime/realtime.service';
import { TenancyService, TenantClient } from '../tenancy/tenancy.service';
import { inChainWith } from '../tickets/chain';
import { rethrowChainConflict, TicketService } from '../tickets/ticket.service';
import { replyOutcomeFor } from './contact-reply';
import { MessageService } from './message.service';

/** What a reply did, beside being posted. */
export interface ContactReply {
  message: Message;
  /**
   * The Ticket the Message actually landed on.
   *
   * Not always the one the client addressed: a reply to a `closed` Ticket lands
   * on a freshly spawned one, or on the chain's existing live one. Returned
   * rather than left implicit because a portal that posted to Ticket A and got
   * back a Message on Ticket B needs to be told, and inferring it from the
   * Message would make every client re-derive the rule.
   */
  ticket: Ticket;
}

/**
 * A customer's reply, and what it does to the Ticket it lands on.
 *
 * The one place the three outcomes in `replyOutcomeFor` are carried out, and it
 * is deliberately a service of its own rather than a branch inside
 * `MessageService.post`. Staff and Contacts post Messages through the same
 * table, but only a Contact's reply moves a Ticket: an agent replying to a
 * `resolved` Ticket is following up, not disputing the resolution, and folding
 * both into one method would put a principal-kind test in the middle of the
 * write path — the kind of check that is one forgotten branch from being no
 * check at all. Here the surface answers it: this class takes a
 * `ContactPrincipal` and there is no overload that does not.
 *
 * Everything happens in one transaction, which is the point of the class. A
 * reopen without its Message puts a Ticket back in a queue with nothing new to
 * read; a Message without its reopen leaves the customer's words on a Ticket
 * nobody is looking at; a spawned Ticket without its first Message is a thread
 * born empty whose first-response clock measures from nothing. All three are
 * unreachable rather than unlikely.
 */
@Injectable()
export class ContactReplyService {
  constructor(
    private readonly tenancy: TenancyService,
    private readonly tickets: TicketService,
    private readonly messages: MessageService,
    private readonly realtime: RealtimeService,
  ) {}

  /**
   * Posts a Contact's reply, reopening or spawning as the Ticket's state
   * requires.
   *
   * `source` is the channel the reply physically arrived on, supplied by the
   * surface that took it — `portal` here, `widget` and `slack` when those land.
   * It is not inherited from the parent Ticket, and that is what keeps channel
   * analytics honest: a Ticket's Source is the channel it *originated* on, and a
   * spawned Ticket originates wherever the reply came in. For a Slack-threaded
   * conversation the value happens to match the parent's; the rule is still
   * "where it actually arrived".
   */
  async reply(
    principal: ContactPrincipal,
    ticketId: string,
    body: string,
    source: TicketSource,
  ): Promise<ContactReply> {
    const { reply, landing } = await this.tenancy.withTenant(
      tenantContextFor(principal),
      async (tx) => {
        const addressed = await tx.ticket.findUnique({
          where: { id: ticketId },
        });

        // A Ticket requested by another Contact is invisible in this context, so
        // this is the same 404 a nonexistent one gets — which is the answer it
        // must be, since the alternative confirms somebody else's support request
        // is real.
        if (!addressed) throw AppException.notFound('Ticket');

        const target = await this.targetFor(tx, principal, addressed, source);

        return {
          landing: target.landing,
          reply: {
            ticket: target.ticket,
            message: await this.messages.postIn(
              tx,
              principal,
              target.ticket.id,
              body,
            ),
          },
        };
      },
    );

    await this.announce(reply, landing);

    return reply;
  }

  /**
   * The reply, announced on the socket once its transaction has committed.
   *
   * Two facts, in the order a console needs to apply them: the Ticket first,
   * then the Message on it. A dashboard receiving the Message first would be
   * asked to render an entry on a Ticket it has never heard of — which is
   * exactly the case for a spawn, where the Ticket is new — and would have to
   * hold it aside until the other event arrived.
   *
   * The three landings really are three different announcements, which is why
   * the branch this switch reads was threaded back out of the transaction rather
   * than re-derived here. A spawn is `ticket.created` because a Ticket appeared
   * in the queue; a reopen is `ticket.updated` because one moved; an append
   * changed no Ticket at all and announcing one would have a dashboard
   * re-rendering a row for something that only happened in the thread.
   *
   * `join` is a reopen for this purpose and not a creation: the Ticket the reply
   * landed on already existed and was already announced when it was spawned, so
   * a second `ticket.created` would have a console adding the same row twice.
   */
  private async announce(
    reply: ContactReply,
    landing: ReplyLanding,
  ): Promise<void> {
    if (landing === 'spawn') await this.realtime.ticketCreated(reply.ticket);
    if (landing === 'reopen') await this.realtime.ticketUpdated(reply.ticket);

    await this.realtime.messageCreated(reply.message);
  }

  /** Where this reply belongs, after any state change it causes. */
  private async targetFor(
    tx: TenantClient,
    principal: ContactPrincipal,
    addressed: Ticket,
    source: TicketSource,
  ): Promise<ReplyTarget> {
    switch (replyOutcomeFor(addressed.state)) {
      case 'append':
        return { ticket: addressed, landing: 'append' };

      // Always to `open`, never back to whatever it was before. `resolved` and
      // `pending` both mean "the ball is not in our court", and a reply moves it
      // back — there is one state for that, which is why there is no `reopened`
      // state to choose between.
      //
      // Through `transitionIn` rather than a direct update, so the reopen is
      // checked by the transition table and audited by the trigger that
      // permitted it. The audit row is attributed to the Contact, which is the
      // honest answer to "who reopened this".
      case 'reopen':
        return {
          ticket: await this.tickets.transitionIn(
            tx,
            principal,
            addressed.id,
            TicketState.open,
          ),
          landing: 'reopen',
        };

      case 'spawn':
        return this.spawnOrJoinLive(tx, principal, addressed, source);
    }
  }

  /**
   * The re-reply invariant: at most one live Ticket per conversation.
   *
   * A customer who replies three times to a closed Ticket must end up with one
   * new Ticket, not three. So a spawn is conditional — if the chain already has
   * a Ticket that is not `closed`, this reply joins it, and only an entirely
   * closed chain gets a new one.
   *
   * The read is the cheap half of that guarantee and not the load-bearing half.
   * Two replies arriving together both see no live Ticket and both try to spawn;
   * what stops the second is `ticket_one_live_per_chain`, the unique partial
   * index in the linkage migration, which turns the loser into a 409 instead of
   * a duplicate the queue then carries forever. The read is here so that the
   * ordinary case — a customer replying twice over a minute — is served rather
   * than refused.
   */
  private async spawnOrJoinLive(
    tx: TenantClient,
    principal: ContactPrincipal,
    parent: Ticket,
    source: TicketSource,
  ): Promise<ReplyTarget> {
    const live = await tx.ticket.findFirst({
      where: {
        ...inChainWith(parent),
        state: { not: TicketState.closed },
      },
    });

    // Joining a live Ticket is not the same as appending to it blindly. The
    // customer addressed a closed Ticket, but the reply lands on this one — so
    // it has to answer the same question that one did: an agent may have worked
    // the spawned Ticket and parked it `pending`, or resolved it, and a reply
    // must reopen it exactly as it would have if the customer had addressed it
    // directly. Without this the customer's dispute lands on a Ticket nobody
    // re-queues, which is the failure the whole reopen rule exists to prevent.
    //
    // The recursion terminates in one step and cannot spawn again: `live` is
    // never `closed` by the query above, and `spawn` is the outcome of `closed`
    // alone.
    if (live) return this.targetFor(tx, principal, live, source);

    return {
      landing: 'spawn',
      ticket: await this.tickets
        .createIn(tx, principal, {
          // Inherited verbatim, and deliberately not prefixed. A `Re:` would accrete
          // on every spawn in a long-running conversation, and it would be a second,
          // worse statement of something the linkage already says exactly — that
          // this Ticket continues that one.
          subject: parent.subject,
          // From the credential, as everywhere on the customer axis. It is also the
          // one thing a spawned Ticket inherits in substance: the same person is
          // still asking.
          contactId: principal.contactId,
          // Where the reply arrived, not where the parent started.
          source,
          // Priority and assignee are absent, which is the inheritance rule stated
          // by omission: both fall to the column defaults, so the Ticket is born
          // `normal` and unassigned. Carrying a stale `urgent` forward would arm a
          // breach on a brand-new SLA clock, and carrying an assignee would hand
          // work to whoever happened to hold the last conversation, possibly weeks
          // ago. An agent re-triages, which is the same explicit act triage always
          // is here.
          spawnedFromTicketId: parent.id,
        })
        // The read above lost a race: another reply spawned this chain's live
        // Ticket between that query and this insert, and the unique index refused
        // the duplicate.
        .catch(rethrowChainConflict),
    };
  }
}

/**
 * Which of the three things a reply did to a Ticket.
 *
 * Distinct from `replyOutcomeFor`'s answer, which is a decision made from the
 * addressed Ticket's state *before* anything happens. This is what actually
 * became of the reply — the two differ in exactly one case, where a `spawn`
 * decision meets a chain that already has a live Ticket and lands as a `reopen`
 * or an `append` on it instead.
 *
 * It exists because the socket needs it and nothing else does: only the
 * announcement has to tell a new Ticket from a moved one. It is carried out of
 * the transaction rather than recomputed afterwards, because after the commit
 * there is no longer enough information to tell the two apart — a Ticket spawned
 * a moment ago and one spawned last week look identical.
 */
type ReplyLanding = 'append' | 'reopen' | 'spawn';

interface ReplyTarget {
  ticket: Ticket;
  landing: ReplyLanding;
}
