import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { AppException } from 'src/common/errors/app-exception';
import { ApiErrorResponses } from 'src/common/errors/api-error-responses.decorator';
import { ApiPaginatedResponse } from 'src/common/pagination/api-paginated-response.decorator';
import { buildPage, Page } from 'src/common/pagination/page';
import { PaginationQuery } from 'src/common/pagination/pagination-query.dto';
import {
  decodeCursor,
  assertCursorMatchesSort,
} from 'src/common/pagination/cursor';
import { parseSort } from 'src/common/pagination/sort';

/**
 * A test-only resource that consumes the shared API kit exactly as a real
 * resource will.
 *
 * The conventions are cross-cutting, so they have to be asserted through a
 * booted application over HTTP rather than by calling the helpers directly —
 * only that seam proves the global filter and pipe are actually wired.
 */

export class WidgetDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  createdAt!: string;
}

const SORTABLE = ['createdAt', 'label'] as const;

export class ProbeQuery extends PaginationQuery {
  @ApiPropertyOptional({ enum: ['red', 'blue'] })
  @IsOptional()
  @IsIn(['red', 'blue'])
  colour?: string;

  @ApiPropertyOptional({ description: '`field` or `-field`.' })
  @IsOptional()
  @IsString()
  sort?: string;
}

export class ProbeBody {
  @ApiProperty()
  @IsString()
  label!: string;

  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  count!: number;
}

/** A fixed corpus, newest first, so cursor traversal is deterministic. */
const ROWS: WidgetDto[] = Array.from({ length: 7 }, (_, i) => ({
  id: `w_${6 - i}`,
  createdAt: new Date(Date.UTC(2026, 6, 7 - i)).toISOString(),
}));

@Controller('probe')
export class ProbeController {
  @Get()
  @ApiPaginatedResponse(WidgetDto)
  @ApiErrorResponses('invalid_filter', 'invalid_sort', 'invalid_cursor')
  list(@Query() query: ProbeQuery): Page<WidgetDto> {
    const sort = parseSort(query.sort, SORTABLE);

    let rows = ROWS;

    if (query.cursor !== undefined) {
      const position = decodeCursor(query.cursor);
      assertCursorMatchesSort(position, sort);
      const at = rows.findIndex((r) => r.id === position.id);
      rows = rows.slice(at + 1);
    }

    return buildPage(rows.slice(0, query.limit + 1), query.limit, sort);
  }

  @Get('one')
  @ApiErrorResponses('not_found')
  one(): WidgetDto {
    // Bare resource, no `data` wrapper.
    return ROWS[0];
  }

  @Get('missing')
  @ApiErrorResponses('not_found')
  missing(): never {
    throw AppException.notFound('widget');
  }

  @Get('boom')
  boom(): never {
    throw new Error('a secret internal detail that must not reach the client');
  }

  @Post()
  @ApiErrorResponses('validation_failed')
  create(@Body() body: ProbeBody): ProbeBody {
    return body;
  }
}
