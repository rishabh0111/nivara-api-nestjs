import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { PaginationQuery } from '../../common/pagination/pagination-query.dto';

/**
 * The query surface of a timeline, which is pagination and nothing else.
 *
 * There are deliberately no filters. Narrowing a history by action or actor is
 * how a reader convinces themselves they have seen everything when they have
 * seen a slice — and the per-ticket timeline is short enough that scanning it
 * is the honest interaction. The tenant-wide forensic feed, where filtering
 * would genuinely be needed, is a separate endpoint that does not exist yet.
 */
export class ListAuditQuery extends PaginationQuery {
  @ApiPropertyOptional({
    description:
      '`createdAt`, with a leading `-` for descending. Defaults to `-createdAt` — newest first. Changing it invalidates a cursor.',
    example: '-createdAt',
  })
  @IsOptional()
  @IsString()
  sort?: string;
}
