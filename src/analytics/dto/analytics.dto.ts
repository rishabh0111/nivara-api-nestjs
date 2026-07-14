import { ApiProperty } from '@nestjs/swagger';
import { GROUP_BY_AXES } from '../analytics-query';

/**
 * A rate on the wire: the numerator, and the fraction it forms of the cohort.
 *
 * Both, rather than only the ratio, so a client can show "12 of 340" as readily
 * as "3.5%" and never has to reconstruct a count from a rounded percentage.
 * `rate` is null exactly when the cohort is empty — the honest answer to a
 * proportion of nothing, rather than a zero that would read as "none breached".
 */
export class RateDto {
  @ApiProperty({ description: 'The numerator — how many tickets this counts.' })
  count!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'The fraction of the cohort, in [0, 1], or null over an empty cohort.',
  })
  rate!: number | null;
}

/**
 * A duration distribution in milliseconds, at the median and the 90th
 * percentile.
 *
 * p50 and p90 rather than a mean: a single stale Ticket drags an average
 * somewhere no real Ticket sits, whereas the pair says what a typical
 * experience was and how bad the tail got. Where a distribution is present both
 * percentiles are; the "no Ticket in the cut had the timer" case is carried one
 * level up, as a null `firstResponseMs`/`resolutionMs` on `MetricsDto`, rather
 * than as a half-populated object here.
 */
export class DurationDto {
  @ApiProperty({ description: 'Median (50th percentile), milliseconds.' })
  p50!: number;

  @ApiProperty({ description: '90th percentile, milliseconds.' })
  p90!: number;
}

/**
 * The four headline rates and two durations for one cohort.
 *
 * The rates share one denominator — `cohortSize`, the Tickets created in the
 * window — so they are directly comparable slices of the same cohort rather
 * than four figures over four differently-shaped populations. The two breach
 * rates are reported apart precisely so a slow start is distinguishable from a
 * slow finish.
 */
export class MetricsDto {
  @ApiProperty({
    description:
      'The shared denominator: Tickets created in the window. Every rate below is over this.',
  })
  cohortSize!: number;

  @ApiProperty({
    type: RateDto,
    description:
      'Terminal Tickets with no agent touch — no user-authored Message or Note. Credits AI handling and self-service only.',
  })
  deflection!: RateDto;

  @ApiProperty({
    type: RateDto,
    description: 'Tickets that reached `resolved` or `closed`.',
  })
  resolution!: RateDto;

  @ApiProperty({
    type: RateDto,
    description:
      'Tickets whose first-response SLA latch is set — a slow start.',
  })
  firstResponseBreach!: RateDto;

  @ApiProperty({
    type: RateDto,
    description: 'Tickets whose resolution SLA latch is set — a slow finish.',
  })
  resolutionBreach!: RateDto;

  @ApiProperty({
    type: DurationDto,
    nullable: true,
    description:
      'Time from creation to first agent-visible reply, over Tickets that got one.',
  })
  firstResponseMs!: DurationDto | null;

  @ApiProperty({
    type: DurationDto,
    nullable: true,
    description:
      'Pause-aware active time to terminal, over Tickets that reached one.',
  })
  resolutionMs!: DurationDto | null;
}

/** A `MetricsDto` block tagged with the group value it describes. */
export class GroupMetricsDto extends MetricsDto {
  @ApiProperty({
    description:
      'The group value — the priority, source, assignee id, or `YYYY-MM-DD` day this slice is for.',
  })
  key!: string;
}

/**
 * The whole report.
 *
 * `overall` is always present, so a grouped report carries the total its groups
 * slice — for priority, source and day the group cohort sizes sum to it; for
 * assignee they sum to the agent-touched, assigned subset, since that cut drops
 * deflected and unassigned Tickets by definition.
 */
export class AnalyticsReportDto {
  @ApiProperty({
    format: 'date-time',
    description: 'The cohort window start (inclusive).',
  })
  from!: string;

  @ApiProperty({
    format: 'date-time',
    description: 'The cohort window end (exclusive).',
  })
  to!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    enum: GROUP_BY_AXES,
    description:
      'The axis the breakdown is over, or null for the ungrouped report.',
  })
  groupBy!: string | null;

  @ApiProperty({
    type: MetricsDto,
    description: 'The figures over the whole cohort.',
  })
  overall!: MetricsDto;

  @ApiProperty({
    type: [GroupMetricsDto],
    nullable: true,
    description:
      'The per-group breakdown, or null when no group-by was asked for.',
  })
  groups!: GroupMetricsDto[] | null;
}
