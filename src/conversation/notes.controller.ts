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
import { CreateNoteDto } from './dto/create-note.dto';
import { ListThreadQuery } from './dto/list-thread.dto';
import { NoteDto, toNoteDto } from './dto/note.dto';
import { NoteService } from './note.service';

/**
 * The staff-only surface, which is what "their own surface" means: Notes have
 * their own route, their own permissions and their own table, and the only way
 * to read one is to ask for one here.
 *
 * `note:read` is a grant in its own right rather than something `ticket:read`
 * implies. That separation is what will let a future read-only integration —
 * or a Contact-facing principal — hold the ability to read a Ticket's thread
 * without also holding the ability to read what staff said about it.
 */
@ApiTags('conversation')
@ApiBearerAuth()
@Controller('tickets/:id/notes')
export class NotesController {
  constructor(private readonly notes: NoteService) {}

  @Post()
  @RequiresPermission('note:write')
  @ApiParam({ name: 'id', format: 'uuid', description: 'The Ticket’s id.' })
  @ApiOperation({
    summary: 'Write an internal Note',
    description:
      'Never visible to the Contact, and not by virtue of a flag this endpoint sets — a Note is a row in a different table, and the customer-visible thread read does not look there. The author is stamped from the credential, as it is for a Message.',
  })
  @ApiCreatedResponse({ type: NoteDto })
  @ApiErrorResponses(
    'malformed_request',
    'validation_failed',
    'unauthenticated',
    'forbidden',
    'not_found',
  )
  async write(
    @Principal() principal: RequestPrincipal,
    @Param('id', UuidParam) id: string,
    @Body() body: CreateNoteDto,
  ): Promise<NoteDto> {
    return toNoteDto(await this.notes.write(principal, id, body.body));
  }

  @Get()
  @RequiresPermission('note:read')
  @ApiParam({ name: 'id', format: 'uuid', description: 'The Ticket’s id.' })
  @ApiOperation({
    summary: 'Read a Ticket’s internal Notes',
    description:
      'Notes only, newest first, in the standard list envelope. Interleaving them with the customer-visible thread is the client’s job: it reads both endpoints and merges by `createdAt`, so nothing on the server ever holds a mixed collection that could be serialized to the wrong audience.',
  })
  @ApiPaginatedResponse(NoteDto)
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
  ): Promise<Page<NoteDto>> {
    const page = await this.notes.listForTicket(principal, id, query);

    return { data: page.data.map(toNoteDto), nextCursor: page.nextCursor };
  }
}
