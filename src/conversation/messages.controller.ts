import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Principal } from '../auth/principal.decorator';
import { RequestPrincipal } from '../auth/request-principal';
import { RequiresPermission } from '../authz/require-permission.decorator';
import { ApiErrorResponses } from '../common/errors/api-error-responses.decorator';
import { ApiPaginatedResponse } from '../common/pagination/api-paginated-response.decorator';
import { Page } from '../common/pagination/page';
import { UuidParam } from '../common/validation/uuid-param.pipe';
import { CreateMessageDto } from './dto/create-message.dto';
import { ListThreadQuery } from './dto/list-thread.dto';
import { MessageDto, toMessageDto } from './dto/message.dto';
import { MessageService } from './message.service';

/**
 * The customer-visible thread.
 *
 * A separate controller from `NotesController` rather than one conversation
 * surface with a kind parameter, so the two never share a handler that could
 * be pointed at the wrong table. `ticket:reply` and `note:write` are also
 * separate grants — the AI layer will hold one and not the other — and a
 * combined route could not tell them apart without authorizing per-field.
 */
@ApiTags('conversation')
@ApiBearerAuth()
@Controller('tickets/:id/messages')
export class MessagesController {
  constructor(private readonly messages: MessageService) {}

  @Post()
  @RequiresPermission('ticket:reply')
  @ApiParam({ name: 'id', format: 'uuid', description: 'The Ticket’s id.' })
  @ApiOperation({
    summary: 'Post a customer-visible Message',
    description:
      'The author is not part of the request: `authorKind` and `authorId` are stamped from the credential that made it, so a Message cannot be attributed to anyone else. For internal context that the Contact must not see, write a Note instead — a different endpoint over a different table, not a flag on this one.',
  })
  @ApiCreatedResponse({ type: MessageDto })
  @ApiErrorResponses(
    'malformed_request',
    'validation_failed',
    'unauthenticated',
    'forbidden',
    'not_found',
  )
  async post(
    @Principal() principal: RequestPrincipal,
    @Param('id', UuidParam) id: string,
    @Body() body: CreateMessageDto,
  ): Promise<MessageDto> {
    return toMessageDto(await this.messages.post(principal, id, body.body));
  }

  @Get()
  @RequiresPermission('ticket:read')
  @ApiParam({ name: 'id', format: 'uuid', description: 'The Ticket’s id.' })
  @ApiOperation({
    summary: 'Read a Ticket’s customer-visible thread',
    description:
      'Messages only, newest first, in the standard list envelope. Notes are structurally absent rather than filtered out — they are a separate table, and no parameter to this endpoint can reach them.',
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
  async list(
    @Principal() principal: RequestPrincipal,
    @Param('id', UuidParam) id: string,
    @Query() query: ListThreadQuery,
  ): Promise<Page<MessageDto>> {
    const page = await this.messages.listForTicket(principal, id, query);

    return { data: page.data.map(toMessageDto), nextCursor: page.nextCursor };
  }
}
