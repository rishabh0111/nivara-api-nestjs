import { Injectable } from '@nestjs/common';
import { RequestPrincipal, tenantContextFor } from '../auth/request-principal';
import { buildPage, Page } from '../common/pagination/page';
import { Message } from '../generated/prisma/client';
import { OutboundDispatchService } from '../outbound/outbound-dispatch.service';
import { RealtimeService } from '../realtime/realtime.service';
import { TenancyService, TenantClient } from '../tenancy/tenancy.service';
import {
  assertTicketVisible,
  ListThreadInput,
  rethrowMissingTicket,
  threadQuery,
} from './thread';

/**
 * The customer-visible thread.
 *
 * Every query in this class names `tx.message`, and there is no parameter,
 * option or flag that could make one of them name `tx.note` instead. That is
 * the ticket's last requirement — "no code path can return a Note through the
 * customer-visible thread read" — discharged by the absence of the code that
 * would do it rather than by a check that has to be right.
 *
 * The corollary is that this service can never grow an `includeNotes` option.
 * If an agent console wants both, it makes two calls and interleaves them by
 * `createdAt`; joining them here would put the two kinds of entry back in one
 * result set, one boolean away from the wrong one being serialized.
 */
@Injectable()
export class MessageService {
  constructor(
    private readonly tenancy: TenancyService,
    private readonly realtime: RealtimeService,
    private readonly outbound: OutboundDispatchService,
  ) {}

  /**
   * Posts a customer-visible Message.
   *
   * Nothing about who is writing appears in the input. `authorKind` and
   * `authorId` are stamped by a trigger from the transaction's armed context,
   * so attribution is a fact about the credential rather than a claim this
   * method makes — which is what lets a later deflection metric count
   * `service`-authored Messages and be believed.
   *
   * The visibility check ahead of the write is deliberate, and it was
   * deliberately *absent* until the Contact principal arrived — the reasoning
   * has changed, so the code has. The old argument was that the composite
   * foreign key on `(tenant_id, ticket_id)` already refused every Ticket this
   * caller could not legitimately write to, making a pre-read the same answer
   * plus a race. That was true while the only boundary was the tenant.
   *
   * It stopped being true with a second axis inside one tenant. A Contact
   * posting to another Contact's Ticket names a `ticket_id` that genuinely
   * exists in this tenant, so the foreign key is satisfied and the row is
   * refused instead by the policy's `WITH CHECK` — which arrives as a bare
   * privilege error, not the `P2003` the catch below reads, and would surface as
   * a 500. The right answer is the same 404 every other invisible Ticket gets.
   *
   * Both guards are kept. The check answers the ownership case; the catch still
   * answers the cross-tenant one and the genuine race where a Ticket is deleted
   * between the two statements. They run in one transaction, so the read and the
   * write cannot disagree about a Ticket that merely changed.
   *
   * Posting on a `closed` Ticket is not refused here. Whether a reply reopens a
   * Ticket, starts a linked one, or is turned away is ticket 10's question, and
   * answering half of it now would mean a rule in this method that the reply
   * path then has to disagree with.
   */
  async post(
    principal: RequestPrincipal,
    ticketId: string,
    body: string,
  ): Promise<Message> {
    const message = await this.tenancy.withTenant(
      tenantContextFor(principal),
      (tx) => this.postIn(tx, principal, ticketId, body),
    );

    // After the commit, and only on this path. `postIn` announces nothing,
    // because its caller owns the transaction and a reply that reopens a Ticket
    // has two facts to announce together — see `ContactReplyService`.
    await this.realtime.messageCreated(message);

    return message;
  }

  /**
   * The same post, inside a transaction the caller already owns.
   *
   * `ContactReplyService` needs it: a customer's reply may reopen a Ticket or
   * spawn a linked one, and the Message is part of that same act. A spawned
   * Ticket that committed without its first Message would be a thread born
   * empty with a first-response clock measuring from nothing.
   *
   * It exists here rather than as a `tx.message.create` at the call site so that
   * this class keeps its defining property: every query that names `message`
   * names it in this file. A reply path reaching for the table directly would be
   * the first crack in "no code path can return a Note through the
   * customer-visible thread read", because it would be a second place that
   * decides which table a thread lives in.
   */
  async postIn(
    tx: TenantClient,
    principal: RequestPrincipal,
    ticketId: string,
    body: string,
  ): Promise<Message> {
    await assertTicketVisible(tx, ticketId);

    const message = await tx.message
      .create({ data: { tenantId: principal.tenantId, ticketId, body } })
      .catch(rethrowMissingTicket);

    // The one line that connects the conversation to the outside world, and it
    // is here — in the single method every Message in this system is written by —
    // rather than at each surface that posts one. A reply typed by an agent, one
    // written by the AI layer, and one that arrives on a spawned Ticket through
    // the reply path all reach the customer's channel by the same route, because
    // they all reach it through this statement.
    //
    // Inside the transaction, so the Message and the promise to deliver it commit
    // together: a Message that committed with nothing scheduled is a reply that
    // silently never leaves, and a scheduled delivery for a Message that rolled
    // back is a handler that cannot find its own subject.
    //
    // Whether anything is actually queued is not this file's business, and
    // deliberately so — `OutboundDispatchService` answers it from the Ticket's own
    // columns, so `MessageService` stays innocent of Slack, of channels, and of
    // the fact that a customer's own words must never be posted back at them.
    await this.outbound.dispatchIn(tx, message);

    return message;
  }

  /** A page of one Ticket's Messages — and only Messages. */
  async listForTicket(
    principal: RequestPrincipal,
    ticketId: string,
    input: ListThreadInput,
  ): Promise<Page<Message>> {
    const { sort, plan, take } = threadQuery(input);

    const rows = await this.tenancy.withTenant(
      tenantContextFor(principal),
      async (tx) => {
        await assertTicketVisible(tx, ticketId);

        return tx.message.findMany({
          // ANDed rather than spread, for the reason `TicketService.list`
          // gives: both halves bound `createdAt` on some pages, and merging
          // key-by-key would let one overwrite the other and restart the
          // traversal.
          where: { AND: [{ ticketId }, plan.where ?? {}] },
          orderBy: plan.orderBy,
          take,
        });
      },
    );

    return buildPage(rows, input.limit, sort);
  }
}
