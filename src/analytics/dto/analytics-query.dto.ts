import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { GROUP_BY_AXES } from '../analytics-query';

/**
 * The query surface of `GET /analytics`, and the whole of it.
 *
 * Declaring each parameter here is what makes an unknown one a 400: the
 * unknown-parameter guard derives what this route accepts from the properties
 * this class declares, so a typo'd `groupby` is refused rather than silently
 * dropped and answered over the default window.
 *
 * The values are typed as strings and validated in `planAnalytics` rather than
 * by decorators — `@IsEnum` on `groupBy` would give a generic 422 where the
 * planner gives one `invalid_filter` covering the window and the axis alike, and
 * the instant parsing has nowhere to live on a decorator anyway. One validator
 * owns the whole surface and is unit-tested in isolation.
 */
export class AnalyticsQueryDto {
  @ApiPropertyOptional({
    description:
      'ISO-8601. The cohort is Tickets created at or after this instant. Defaults to 30 days before `to`.',
    example: '2026-06-20T00:00:00.000Z',
  })
  @IsOptional()
  @IsString()
  from?: string;

  @ApiPropertyOptional({
    description:
      'ISO-8601. The cohort is Tickets created strictly before this instant. Defaults to now.',
    example: '2026-07-20T00:00:00.000Z',
  })
  @IsOptional()
  @IsString()
  to?: string;

  @ApiPropertyOptional({
    description: `Break the figures down by one axis. One of: ${GROUP_BY_AXES.join(', ')}. Omit for the ungrouped report.`,
    enum: GROUP_BY_AXES,
  })
  @IsOptional()
  @IsString()
  groupBy?: string;
}
