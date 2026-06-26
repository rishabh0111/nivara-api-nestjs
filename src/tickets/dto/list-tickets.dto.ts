import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { PaginationQuery } from '../../common/pagination/pagination-query.dto';
import {
  TicketPriority,
  TicketSource,
  TicketState,
} from '../../generated/prisma/client';
import { UNASSIGNED } from '../ticket-filters';

/**
 * The filter surface of `GET /tickets`, and nothing beyond it.
 *
 * Declaring each parameter here is what makes an unknown one a 400: the
 * unknown-parameter guard derives what a route accepts from the properties
 * this class declares, so a typo'd filter is refused rather than ignored.
 *
 * The values are typed as strings and validated in `ticketWhere` rather than
 * by decorators, because the multi-valued ones are comma lists — `@IsEnum` on
 * `open,pending` would reject a request the contract allows. One parser owns
 * the whole filter vocabulary, and it is unit-tested in isolation.
 */
export class ListTicketsQuery extends PaginationQuery {
  @ApiPropertyOptional({
    description: `One state, or several comma-separated. One of: ${Object.values(TicketState).join(', ')}.`,
    example: 'open,pending',
  })
  @IsOptional()
  @IsString()
  state?: string;

  @ApiPropertyOptional({
    description: `One priority, or several comma-separated. One of: ${Object.values(TicketPriority).join(', ')}.`,
    example: 'high,urgent',
  })
  @IsOptional()
  @IsString()
  priority?: string;

  @ApiPropertyOptional({
    description: `One source, or several comma-separated. One of: ${Object.values(TicketSource).join(', ')}.`,
    example: 'widget',
  })
  @IsOptional()
  @IsString()
  source?: string;

  @ApiPropertyOptional({
    description: `A User's id, or \`${UNASSIGNED}\` for untriaged Tickets.`,
  })
  @IsOptional()
  @IsString()
  assigneeId?: string;

  @ApiPropertyOptional({ description: "A Contact's id — the requester." })
  @IsOptional()
  @IsString()
  contactId?: string;

  @ApiPropertyOptional({
    description: 'ISO-8601. Tickets created at or after this instant.',
  })
  @IsOptional()
  @IsString()
  createdAfter?: string;

  @ApiPropertyOptional({
    description: 'ISO-8601. Tickets created at or before this instant.',
  })
  @IsOptional()
  @IsString()
  createdBefore?: string;

  @ApiPropertyOptional({
    description:
      '`createdAt` or `updatedAt`, with a leading `-` for descending. Defaults to `-createdAt`. Changing it invalidates a cursor.',
    example: '-createdAt',
  })
  @IsOptional()
  @IsString()
  sort?: string;
}
