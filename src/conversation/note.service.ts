import { Injectable } from '@nestjs/common';
import { RequestPrincipal, tenantContextFor } from '../auth/request-principal';
import { buildPage, Page } from '../common/pagination/page';
import { Note } from '../generated/prisma/client';
import { TenancyService } from '../tenancy/tenancy.service';
import {
  assertTicketVisible,
  ListThreadInput,
  rethrowMissingTicket,
  threadQuery,
} from './thread';

/**
 * The agent-only thread.
 *
 * A near-copy of `MessageService`, and the duplication is the design rather
 * than an oversight. Folding the two into one service parameterized by "which
 * kind" would reintroduce exactly the discriminator the separate tables exist
 * to avoid: one code path, one argument deciding what comes back, and a
 * customer-facing caller one wrong argument away from a leak. Two services that
 * happen to read alike cannot make that mistake, because neither can express
 * it.
 *
 * What the two genuinely share — the sortable field, the body limit, and the
 * two refusals — lives in `thread.ts`, where nothing names a table.
 */
@Injectable()
export class NoteService {
  constructor(private readonly tenancy: TenancyService) {}

  /**
   * Writes an internal Note.
   *
   * Attributed by the same trigger as a Message, from the same armed context.
   * Notes are where an agent records what they suspect rather than what they
   * will say, so "who wrote this" carries more weight here than on the
   * customer-visible side, not less.
   */
  async write(
    principal: RequestPrincipal,
    ticketId: string,
    body: string,
  ): Promise<Note> {
    return this.tenancy.withTenant(tenantContextFor(principal), (tx) =>
      tx.note
        .create({ data: { tenantId: principal.tenantId, ticketId, body } })
        .catch(rethrowMissingTicket),
    );
  }

  /** A page of one Ticket's Notes, on their own surface. */
  async listForTicket(
    principal: RequestPrincipal,
    ticketId: string,
    input: ListThreadInput,
  ): Promise<Page<Note>> {
    const { sort, plan, take } = threadQuery(input);

    const rows = await this.tenancy.withTenant(
      tenantContextFor(principal),
      async (tx) => {
        await assertTicketVisible(tx, ticketId);

        return tx.note.findMany({
          where: { AND: [{ ticketId }, plan.where ?? {}] },
          orderBy: plan.orderBy,
          take,
        });
      },
    );

    return buildPage(rows, input.limit, sort);
  }
}
