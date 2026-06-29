import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Principal } from '../auth/principal.decorator';
import { RequestPrincipal } from '../auth/request-principal';
import { RequiresPermission } from '../authz/require-permission.decorator';
import { ApiErrorResponses } from '../common/errors/api-error-responses.decorator';
import { ApiPaginatedResponse } from '../common/pagination/api-paginated-response.decorator';
import { UuidParam } from '../common/validation/uuid-param.pipe';
import { Page } from '../common/pagination/page';
import { CreateTicketDto } from './dto/create-ticket.dto';
import { ListTicketsQuery } from './dto/list-tickets.dto';
import { SetAssigneeDto } from './dto/set-assignee.dto';
import { SetPriorityDto } from './dto/set-priority.dto';
import { SetStateDto } from './dto/set-state.dto';
import { TicketDto, toTicketDto } from './dto/ticket.dto';
import { TicketService } from './ticket.service';

/**
 * The queue.
 *
 * Priority and assignment are separate sub-resources rather than fields of a
 * general `PATCH /tickets/:id`, and that is a permissions decision before it
 * is a REST one: `ticket:priority` and `ticket:assign` are distinct grants, and
 * a single patch endpoint would have to authorize per-field — the kind of check
 * that is one forgotten branch away from being no check at all.
 */
@ApiTags('tickets')
@ApiBearerAuth()
@Controller('tickets')
export class TicketsController {
  constructor(private readonly tickets: TicketService) {}

  @Post()
  @RequiresPermission('ticket:create')
  @ApiOperation({
    summary: 'Open a Ticket on a Contact’s behalf',
    description:
      'The Ticket is born `open` with `normal` priority — neither is settable here. Triage is an explicit act, so setting priority or an assignee is a separate, separately permissioned call.',
  })
  @ApiCreatedResponse({ type: TicketDto })
  @ApiErrorResponses(
    'validation_failed',
    'unauthenticated',
    'forbidden',
    'not_found',
  )
  async create(
    @Principal() principal: RequestPrincipal,
    @Body() body: CreateTicketDto,
  ): Promise<TicketDto> {
    return toTicketDto(await this.tickets.create(principal, body));
  }

  @Get()
  @RequiresPermission('ticket:read')
  @ApiOperation({
    summary: 'List Tickets',
    description:
      'Cursor-paginated, newest first by default. Filters and sorts are drawn from a closed per-resource allowlist: an unknown parameter is a 400 rather than something quietly ignored.',
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
    @Principal() principal: RequestPrincipal,
    @Query() query: ListTicketsQuery,
  ): Promise<Page<TicketDto>> {
    const page = await this.tickets.list(principal, query);

    return { data: page.data.map(toTicketDto), nextCursor: page.nextCursor };
  }

  @Get(':id')
  @RequiresPermission('ticket:read')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Read one Ticket',
    description:
      'A Ticket belonging to another tenant answers 404, identically to one that does not exist — a 403 would confirm it is real.',
  })
  @ApiOkResponse({ type: TicketDto })
  @ApiErrorResponses(
    'malformed_request',
    'unauthenticated',
    'forbidden',
    'not_found',
  )
  async findOne(
    @Principal() principal: RequestPrincipal,
    @Param('id', UuidParam) id: string,
  ): Promise<TicketDto> {
    return toTicketDto(await this.tickets.findOne(principal, id));
  }

  @Patch(':id/state')
  @RequiresPermission('ticket:transition')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Move a Ticket to another state',
    description:
      'The active states `open`, `pending` and `on_hold` interconvert freely; any of them may be `resolved`; a `resolved` Ticket reopens to `open` or moves to `closed`. `closed` is terminal — nothing leads out of it, and a later reply from the Contact opens a new linked Ticket. An illegal move answers 409 and is refused by the database rather than by this service, so it is refused identically on every write path.\n\nMoving to `closed` additionally requires `ticket:close`, which `ticket:transition` does not imply. It is checked here rather than on the route because one endpoint serves every transition, so a route-level grant could not tell them apart — a caller holding `ticket:transition` alone reaches this operation and is refused only for that destination.',
  })
  @ApiOkResponse({ type: TicketDto })
  @ApiErrorResponses(
    'malformed_request',
    'validation_failed',
    'unauthenticated',
    'forbidden',
    'not_found',
    'conflict',
  )
  async transition(
    @Principal() principal: RequestPrincipal,
    @Param('id', UuidParam) id: string,
    @Body() body: SetStateDto,
  ): Promise<TicketDto> {
    return toTicketDto(
      await this.tickets.transition(principal, id, body.state),
    );
  }

  @Patch(':id/priority')
  @RequiresPermission('ticket:priority')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Set a Ticket’s priority',
    description:
      'Independent of state: priority is urgency and state is progress, and changing one never moves the other. Not a state transition, so the transition table is not consulted. The single exception is a `closed` Ticket, which is a locked record — a priority edit on one answers 409.',
  })
  @ApiOkResponse({ type: TicketDto })
  @ApiErrorResponses(
    'malformed_request',
    'validation_failed',
    'unauthenticated',
    'forbidden',
    'not_found',
    'conflict',
  )
  async setPriority(
    @Principal() principal: RequestPrincipal,
    @Param('id', UuidParam) id: string,
    @Body() body: SetPriorityDto,
  ): Promise<TicketDto> {
    return toTicketDto(
      await this.tickets.setPriority(principal, id, body.priority),
    );
  }

  @Patch(':id/assignee')
  @RequiresPermission('ticket:assign')
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOperation({
    summary: 'Assign a Ticket, or unassign it',
    description:
      'At most one assignee, and `null` clears it. There are no teams or groups — responsibility has exactly one holder or none.',
  })
  @ApiOkResponse({ type: TicketDto })
  @ApiErrorResponses(
    'malformed_request',
    'validation_failed',
    'unauthenticated',
    'forbidden',
    'not_found',
  )
  async setAssignee(
    @Principal() principal: RequestPrincipal,
    @Param('id', UuidParam) id: string,
    @Body() body: SetAssigneeDto,
  ): Promise<TicketDto> {
    return toTicketDto(
      await this.tickets.setAssignee(principal, id, body.assigneeId),
    );
  }
}
