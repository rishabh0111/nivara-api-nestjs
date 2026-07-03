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
import { WidgetPrincipal } from '../auth/request-principal';
import { RequiresPrincipalKind } from '../authz/require-permission.decorator';
import { ApiErrorResponses } from '../common/errors/api-error-responses.decorator';
import { ApiPaginatedResponse } from '../common/pagination/api-paginated-response.decorator';
import { Page, emptyPage } from '../common/pagination/page';
import { UuidParam } from '../common/validation/uuid-param.pipe';
import { ContactReplyService } from '../conversation/contact-reply.service';
import { CreateMessageDto } from '../conversation/dto/create-message.dto';
import { ListThreadQuery } from '../conversation/dto/list-thread.dto';
import { MessageDto, toMessageDto } from '../conversation/dto/message.dto';
import { MessageService } from '../conversation/message.service';
import { ListTicketsQuery } from '../tickets/dto/list-tickets.dto';
import { TicketDto, toTicketDto } from '../tickets/dto/ticket.dto';
import { TicketService } from '../tickets/ticket.service';
import { AppException } from '../common/errors/app-exception';
import { OpenWidgetTicketDto } from './dto/open-widget-ticket.dto';
import { WidgetSessionService } from './widget-session.service';

/**
 * An anonymous visitor's conversation.
 *
 * Route for route the portal's ticket surface, and that is the design rather
 * than duplication left unfactored. Every handler resolves the session to a
 * `ContactPrincipal` and then calls the *same* `TicketService`,
 * `MessageService` and `ContactReplyService` the portal and the staff console
 * call. There is no widget-flavoured copy of "list my tickets" with its own
 * scoping clause, because a copy is the thing that can be got wrong quietly and
 * permanently. The narrowing happens beneath all three surfaces, in the
 * row-level security policies, which return a Contact only the Tickets it
 * requested no matter which service asked.
 *
 * So what this controller contributes is the same two things the portal's does
 * — a *shape*, and a *Source*. The shape: there is no assign, priority, state,
 * or notes route here, so a widget visitor cannot perform a staff operation
 * because no route on this surface names one (and would be refused three
 * further ways if one did). The Source: everything raised here is `widget`,
 * hard-coded, because a client that could name its own Source could make widget
 * traffic look like portal traffic and rewrite the tenant's channel analytics.
 *
 * The one genuine difference from the portal is *when a Contact exists*. The
 * write paths resolve one, creating it if this is the first act that needs a
 * requester; the read paths deliberately do not, and answer as though the
 * visitor owns nothing — because they do. A read that created a Contact in
 * order to discover it has no Tickets would store something durable about a
 * visitor who has said nothing, which is exactly what this surface promises not
 * to do.
 */
@ApiTags('widget')
@ApiBearerAuth()
// On the class, so every route here — including any added later — inherits it.
// A widget handler that forgot the decorator would be refused outright by the
// fail-closed rule, which is the safe direction; stating it once at the surface
// boundary is what makes "this whole controller is the anonymous axis" a
// property rather than a repeated annotation.
@RequiresPrincipalKind('widget')
@Controller('widget/tickets')
export class WidgetTicketsController {
  constructor(
    private readonly sessions: WidgetSessionService,
    private readonly tickets: TicketService,
    private readonly messages: MessageService,
    private readonly replies: ContactReplyService,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Open a Ticket from the widget',
    description:
      'Born `open` with `normal` priority and Source `widget`. This is the act that makes a Contact exist: an anonymous session resolves to a freshly created, unverified Contact with no email, no name and no credential, and that Contact becomes the Ticket’s requester. A session that already has one reuses it, so a visitor who opens two Tickets in one conversation is one customer rather than two.',
  })
  @ApiCreatedResponse({ type: TicketDto })
  @ApiErrorResponses(
    'validation_failed',
    'unauthenticated',
    'forbidden',
    'not_found',
  )
  async open(
    @Principal() principal: WidgetPrincipal,
    @Body() body: OpenWidgetTicketDto,
  ): Promise<TicketDto> {
    const contact = await this.sessions.contactPrincipalFor(principal);

    return toTicketDto(
      await this.tickets.create(contact, {
        subject: body.subject,
        // From the session, never the body — the same line the DTO's missing
        // `contactId` field exists to make unavoidable.
        contactId: contact.contactId,
        source: 'widget',
      }),
    );
  }

  @Get()
  @ApiOperation({
    summary: 'List this session’s Tickets',
    description:
      'Cursor-paginated, newest first by default, and scoped to the session’s Contact by row-level security rather than by a filter this endpoint applies. A session that has not yet opened a Ticket has no Contact at all and receives an empty page — asking does not create one.',
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
    @Principal() principal: WidgetPrincipal,
    @Query() query: ListTicketsQuery,
  ): Promise<Page<TicketDto>> {
    const contact = this.sessions.existingContactPrincipal(principal);

    if (!contact) return emptyPage();

    const page = await this.tickets.list(contact, query);

    return { data: page.data.map(toTicketDto), nextCursor: page.nextCursor };
  }

  @Get(':id')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Read one of this session’s Tickets',
    description:
      'Another visitor’s Ticket answers 404, identically to one that does not exist and identically to another tenant’s — a 403 would confirm it is real, which is a fact about somebody else’s support request.',
  })
  @ApiOkResponse({ type: TicketDto })
  @ApiErrorResponses(
    'malformed_request',
    'unauthenticated',
    'forbidden',
    'not_found',
  )
  async findOne(
    @Principal() principal: WidgetPrincipal,
    @Param('id', UuidParam) id: string,
  ): Promise<TicketDto> {
    return toTicketDto(await this.tickets.findOne(this.mine(principal), id));
  }

  @Get(':id/messages')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Read the conversation on this session’s Ticket',
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
    @Principal() principal: WidgetPrincipal,
    @Param('id', UuidParam) id: string,
    @Query() query: ListThreadQuery,
  ): Promise<Page<MessageDto>> {
    const page = await this.messages.listForTicket(
      this.mine(principal),
      id,
      query,
    );

    return { data: page.data.map(toMessageDto), nextCursor: page.nextCursor };
  }

  @Post(':id/messages')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Reply on this session’s Ticket',
    description:
      'Attributed to the session’s Contact, stamped from the credential by a database trigger rather than claimed by the request. Posting on a Ticket that is not this session’s answers 404.\n\nA reply is not only a Message: it moves the Ticket it lands on, exactly as a portal reply does. A `pending` or `resolved` Ticket reopens to `open`. A `closed` Ticket is terminal and is not revived — the reply opens a **new linked Ticket** with a fresh clock and becomes its first Message — so read `ticketId` on the response rather than assuming it matches the Ticket addressed.',
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
    @Principal() principal: WidgetPrincipal,
    @Param('id', UuidParam) id: string,
    @Body() body: CreateMessageDto,
  ): Promise<MessageDto> {
    const { message } = await this.replies.reply(
      this.mine(principal),
      id,
      body.body,
      // The channel this reply physically arrived on. Hard-coded because it is a
      // property of *this surface*, not of the request.
      'widget',
    );

    return toMessageDto(message);
  }

  /**
   * The session's Contact for an operation that names a specific Ticket.
   *
   * A session with no Contact owns no Ticket, so every id it could name is one
   * it does not own — and 404 is the answer that gives, identically to a Ticket
   * that does not exist and to another visitor's. Resolving a Contact here
   * instead would create a durable row purely to prove the caller has nothing,
   * which is the one thing this surface promises not to do.
   */
  private mine(principal: WidgetPrincipal) {
    const contact = this.sessions.existingContactPrincipal(principal);

    if (!contact) throw AppException.notFound('Ticket');

    return contact;
  }
}
