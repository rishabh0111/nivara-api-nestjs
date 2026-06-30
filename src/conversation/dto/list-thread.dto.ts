import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { PaginationQuery } from '../../common/pagination/pagination-query.dto';

/**
 * The query surface of a thread: pagination and an ordering, and no filters.
 *
 * Filtering a conversation is not a read anybody wants — a thread with rows
 * missing from the middle is a misleading transcript, not a narrowed one. The
 * one dimension that is offered is direction, because "newest first" and
 * "oldest first" are both honest readings of the same complete thread.
 *
 * Shared by both surfaces because the two ask the same question of two tables.
 * A filter that only made sense for one would be the signal to split it.
 */
export class ListThreadQuery extends PaginationQuery {
  @ApiPropertyOptional({
    description:
      '`createdAt`, with a leading `-` for descending. Defaults to `-createdAt` — newest first, which is where the work is. Ask for `createdAt` to render the thread top-down. Changing it invalidates a cursor.',
    example: 'createdAt',
  })
  @IsOptional()
  @IsString()
  sort?: string;
}
