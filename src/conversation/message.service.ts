import { Injectable } from '@nestjs/common';
import { RequestPrincipal, tenantContextFor } from '../auth/request-principal';
import { buildPage, Page } from '../common/pagination/page';
import { Message } from '../generated/prisma/client';
import { TenancyService } from '../tenancy/tenancy.service';
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
  constructor(private readonly tenancy: TenancyService) {}

  /**
   * Posts a customer-visible Message.
   *
   * Nothing about who is writing appears in the input. `authorKind` and
   * `authorId` are stamped by a trigger from the transaction's armed context,
   * so attribution is a fact about the credential rather than a claim this
   * method makes — which is what lets a later deflection metric count
   * `service`-authored Messages and be believed.
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
    return this.tenancy.withTenant(tenantContextFor(principal), (tx) =>
      tx.message
        .create({ data: { tenantId: principal.tenantId, ticketId, body } })
        .catch(rethrowMissingTicket),
    );
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
