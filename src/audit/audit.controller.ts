import { Controller, Get, Param, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
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
import { AuditService } from './audit.service';
import { AuditEntryDto, toAuditEntryDto } from './dto/audit-entry.dto';
import { ListAuditQuery } from './dto/list-audit.dto';

/**
 * Reading the record.
 *
 * Mounted under `tickets` rather than owned by `TicketsController`, because the
 * two answer to different authority: everything on a Ticket is agent work, and
 * this is not. `audit:read` is admin-only and is deliberately absent from the
 * service-token grant — the AI layer writes history and never reads it, which
 * is the asymmetry that keeps the log a record of the system rather than an
 * input to it.
 *
 * A tenant-wide feed is not here on purpose. The per-ticket timeline is bounded
 * by a real foreign key and answers the question an admin actually asks; a
 * forensic feed across the tenant is a heavier surface — filtering, much larger
 * result sets — and is not needed to reconstruct what happened to a Ticket.
 */
@ApiTags('audit')
@ApiBearerAuth()
@Controller('tickets/:id/audit')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequiresPermission('audit:read')
  @ApiParam({ name: 'id', format: 'uuid', description: 'The Ticket’s id.' })
  @ApiOperation({
    summary: 'Read a Ticket’s audit timeline',
    description:
      'Every control-plane change to this Ticket, newest first, in the standard list envelope. Conversation is not here: Messages and Notes are domain data attributed on their own rows, and the log records changes of state and configuration only.',
  })
  @ApiPaginatedResponse(AuditEntryDto)
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
    @Query() query: ListAuditQuery,
  ): Promise<Page<AuditEntryDto>> {
    const page = await this.audit.listForTicket(principal, id, query);

    return {
      data: page.data.map(toAuditEntryDto),
      nextCursor: page.nextCursor,
    };
  }
}
