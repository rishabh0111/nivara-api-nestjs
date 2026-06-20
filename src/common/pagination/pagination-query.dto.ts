import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export const DEFAULT_PAGE_LIMIT = 25;
export const MAX_PAGE_LIMIT = 100;

/**
 * The pagination half of every list query. Per-resource filter DTOs extend this
 * so `limit` and `cursor` are declared once and appear identically in the
 * generated OpenAPI document on every collection.
 */
export class PaginationQuery {
  @ApiPropertyOptional({
    description: `Maximum rows to return. Defaults to ${DEFAULT_PAGE_LIMIT}.`,
    minimum: 1,
    maximum: MAX_PAGE_LIMIT,
    default: DEFAULT_PAGE_LIMIT,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_LIMIT)
  limit: number = DEFAULT_PAGE_LIMIT;

  @ApiPropertyOptional({
    description:
      "Opaque cursor from a previous response's `nextCursor`. Treat as a black box — its contents are an implementation detail and its format may change. Changing `sort` invalidates it.",
  })
  @IsOptional()
  @IsString()
  cursor?: string;
}
