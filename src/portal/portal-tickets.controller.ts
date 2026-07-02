import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Principal } from '../auth/principal.decorator';
import { ContactPrincipal } from '../auth/request-principal';
import { RequiresPrincipalKind } from '../authz/require-permission.decorator';
import { ApiErrorResponses } from '../common/errors/api-error-responses.decorator';
import { ApiPaginatedResponse } from '../common/pagination/api-paginated-response.decorator';
import { Page } from '../common/pagination/page';
import { UuidParam } from '../common/validation/uuid-param.pipe';
import { CreateMessageDto } from '../conversation/dto/create-message.dto';
import { ListThreadQuery } from '../conversation/dto/list-thread.dto';
import { MessageDto, toMessageDto } from '../conversation/dto/message.dto';
import { ContactReplyService } from '../conversation/contact-reply.service';
import { MessageService } from '../conversation/message.service';
import { ListTicketsQuery } from '../tickets/dto/list-tickets.dto';
import { TicketDto, toTicketDto } from '../tickets/dto/ticket.dto';
import { TicketService } from '../tickets/ticket.service';
import { OpenTicketDto } from './dto/open-ticket.dto';

/**
 * A customer's own tickets.
 *
 * Every handler here delegates to the same `TicketService` and `MessageService`
 * the staff console uses, and that is deliberate rather than lazy. There is no
 * portal-flavoured copy of "list tickets" with an extra `where contactId`
 * clause, because such a copy is exactly the thing that can be got wrong —
 * quietly, once, and forever. The narrowing happens beneath both surfaces, in
 * the row-level security policies, which return a Contact only the Tickets it
 * requested no matter which service asked.
 *
 * So what this controller actually contributes is a *shape*: which operations
 * exist at all. There is no assign endpoint, no priority endpoint, no state
 * endpoint, and no notes endpoint — not because a Contact would be refused at
 * them, though it would be, but because they are not part of this surface. The
 * Notes case is the one worth saying out loud: a Contact cannot reach a Note
 * through this controller because no route here names one, cannot reach one
 * through the staff controller because it holds no `note:read`, and cannot
 * reach one through the database because the policy excludes it. Three
 * independent refusals, no shared assumption.
 */
@ApiTags('portal')
@ApiBearerAuth()
// Declared on the class, so every route here — including any added later —
// inherits it. A portal handler that forgot the decorator would otherwise be
// refused outright by the fail-closed rule, which is the safe direction, but
// stating it once at the surface boundary is what makes "this whole controller
// is the customer axis" a property rather than a repeated annotation.
@RequiresPrincipalKind('contact')
@Controller('portal/tickets')
export class PortalTicketsController {
  constructor(
    private readonly tickets: TicketService,
    private readonly messages: MessageService,
    private readonly replies: ContactReplyService,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Open a Ticket',
    description:
      'Born `open` with `normal` priority and Source `portal`. The requester is the signed-in Contact, taken from the credential — it is not a field of this request, so a Ticket cannot be filed in another customer’s name.',
  })
  @ApiCreatedResponse({ type: TicketDto })
  @ApiErrorResponses(
    'validation_failed',
    'unauthenticated',
    'forbidden',
    'not_found',
  )
  async open(
    @Principal() principal: ContactPrincipal,
    @Body() body: OpenTicketDto,
  ): Promise<TicketDto> {
    return toTicketDto(
      await this.tickets.create(principal, {
        subject: body.subject,
        // From the credential, never the body. This is the line the DTO's
        // missing `contactId` field exists to make unavoidable.
        contactId: principal.contactId,
        source: 'portal',
      }),
    );
  }

  @Get()
  @ApiOperation({
    summary: 'List my Tickets',
    description:
      'Cursor-paginated, newest first by default, and scoped to the signed-in Contact by row-level security rather than by a filter this endpoint applies. Another customer’s Tickets are not excluded from the page — they do not exist in this context at all.',
  })
  @ApiPaginatedResponse(TicketDto)
  @ApiErrorResponses(
    'invalid_filter',
    'invalid_sort',
    'invalid_cursor',
    'unauthenticated',
    'forbidden',
  )
  async list(
    @Principal() principal: ContactPrincipal,
    @Query() query: ListTicketsQuery,
  ): Promise<Page<TicketDto>> {
    const page = await this.tickets.list(principal, query);

    return { data: page.data.map(toTicketDto), nextCursor: page.nextCursor };
  }

  @Get(':id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Read one of my Tickets',
    description:
      'Another customer’s Ticket answers 404, identically to one that does not exist and identically to another tenant’s — a 403 would confirm it is real, which is a fact about somebody else’s support request.',
  })
  @ApiOkResponse({ type: TicketDto })
  @ApiErrorResponses(
    'malformed_request',
    'unauthenticated',
    'forbidden',
    'not_found',
  )
  async findOne(
    @Principal() principal: ContactPrincipal,
    @Param('id', UuidParam) id: string,
  ): Promise<TicketDto> {
    return toTicketDto(await this.tickets.findOne(principal, id));
  }

  @Get(':id/messages')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Read the conversation on my Ticket',
    description:
      'The full customer-visible thread — every Message, whoever wrote it. Notes are not filtered out of this response; they are a different table that this read does not name, are excluded from a Contact’s context by policy, and have no route on this surface.',
  })
  @ApiPaginatedResponse(MessageDto)
  @ApiErrorResponses(
    'malformed_request',
    'invalid_sort',
    'invalid_cursor',
    'unauthenticated',
    'forbidden',
    'not_found',
  )
  async thread(
    @Principal() principal: ContactPrincipal,
    @Param('id', UuidParam) id: string,
    @Query() query: ListThreadQuery,
  ): Promise<Page<MessageDto>> {
    const page = await this.messages.listForTicket(principal, id, query);

    return { data: page.data.map(toMessageDto), nextCursor: page.nextCursor };
  }

  @Post(':id/messages')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Reply on my Ticket',
    description:
      'Attributed to the signed-in Contact, stamped from the credential by a database trigger rather than claimed by the request — which is what makes `authorKind` trustworthy enough to compute deflection from. Posting on a Ticket that is not mine answers 404.\n\nA reply is not only a Message: it moves the Ticket it lands on. A `pending` or `resolved` Ticket reopens to `open`, because the customer has said the matter is not finished. A `closed` Ticket is terminal and is not revived — the reply opens a **new linked Ticket** with a fresh clock, inheriting the requester and its place in the conversation but nothing else, and becomes that Ticket’s first Message. If the conversation already has a Ticket that is not closed, the reply joins it rather than starting another, so replying repeatedly does not produce duplicates.\n\nBecause of that, the Message returned may belong to a different Ticket than the one addressed — read `ticketId` on the response rather than assuming, and read that Ticket\u2019s thread to see the reply in place. `GET /tickets/:id/conversation`, which returns a whole chain at once, is a staff endpoint and is not reachable from this surface.',
  })
  @ApiCreatedResponse({ type: MessageDto })
  @ApiErrorResponses(
    'malformed_request',
    'validation_failed',
    'unauthenticated',
    'forbidden',
    'not_found',
    'conflict',
  )
  async reply(
    @Principal() principal: ContactPrincipal,
    @Param('id', UuidParam) id: string,
    @Body() body: CreateMessageDto,
  ): Promise<MessageDto> {
    const { message } = await this.replies.reply(
      principal,
      id,
      body.body,
      // The channel this reply physically arrived on. Hard-coded because it is a
      // property of *this surface*, not of the request — a client that could
      // name its own Source could make widget traffic look like portal traffic
      // and quietly rewrite the tenant's channel analytics.
      'portal',
    );

    return toMessageDto(message);
  }
}
