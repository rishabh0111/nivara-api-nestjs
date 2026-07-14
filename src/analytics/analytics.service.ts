import { Injectable } from '@nestjs/common';
import { RequestPrincipal, tenantContextFor } from '../auth/request-principal';
import { Prisma } from '../generated/prisma/client';
import { TenancyService, TenantClient } from '../tenancy/tenancy.service';
import { AnalyticsPlan, GroupBy } from './analytics-query';
import {
  AnalyticsReportDto,
  DurationDto,
  MetricsDto,
  RateDto,
} from './dto/analytics.dto';

/**
 * One group's raw aggregate, as Postgres returns it.
 *
 * Counts arrive as `bigint` and percentiles as `number | null` — a percentile
 * over an empty set is SQL `NULL`, which is the honest answer for "the typical
 * first response among tickets that were never answered". `group_key` is null
 * only on the ungrouped report, where there is exactly one such row.
 *
 * The one shape declared here, because it is the one shape with no client: the
 * wire types are the DTO classes, and the service builds and returns those
 * directly rather than a parallel interface set that nothing keeps in step with
 * them.
 */
interface AggregateRow {
  group_key: string | null;
  cohort_size: bigint;
  deflected: bigint;
  resolved: bigint;
  first_response_breached: bigint;
  resolution_breached: bigint;
  first_response_p50: number | null;
  first_response_p90: number | null;
  resolution_p50: number | null;
  resolution_p90: number | null;
}

/**
 * The tenant's numbers, computed live and never rolled up.
 *
 * Every figure is a SQL aggregate over the live `ticket`, `message` and `note`
 * tables inside `withTenant()` — no `MetricsDaily`, no scheduled job, no
 * staleness. Row-level security filters to the tenant *before* the aggregate
 * runs, so a report is structurally incapable of crossing tenants even if a
 * `WHERE tenant_id` were forgotten; there is none in this file, by the same
 * design the rest of the reads follow.
 *
 * The surface returns aggregates only. There is no method here that hands back a
 * Ticket, a Message or a row of any kind — analytics is a reporting read, not a
 * data-export backdoor wearing a dashboard's clothes, and pagination and PII
 * stay the ticket API's concern.
 */
@Injectable()
export class AnalyticsService {
  constructor(private readonly tenancy: TenancyService) {}

  /**
   * The report for one plan, in one transaction.
   *
   * The ungrouped query runs always; the grouped query runs beside it only when
   * a group-by was asked for. Two statements rather than one deriving the total
   * from the groups, because the assignee cut makes the groups a strict subset
   * — summing them would under-report the cohort — and because a partition's
   * total is worth stating rather than trusting a client to reconstruct.
   */
  async report(
    principal: RequestPrincipal,
    plan: AnalyticsPlan,
  ): Promise<AnalyticsReportDto> {
    return this.tenancy.withTenant(tenantContextFor(principal), async (tx) => {
      const overall = await this.aggregate(tx, plan, undefined);
      const groups = plan.groupBy
        ? await this.aggregate(tx, plan, plan.groupBy)
        : undefined;

      return {
        from: plan.from.toISOString(),
        to: plan.to.toISOString(),
        groupBy: plan.groupBy ?? null,
        overall: toMetrics(overall[0] ?? emptyRow()),
        groups: groups
          ? groups.map((row) => ({
              key: row.group_key ?? '',
              ...toMetrics(row),
            }))
          : null,
      };
    });
  }

  /**
   * One aggregate pass over the cohort, grouped or not.
   *
   * The cohort CTE computes the per-ticket predicates once — resolution,
   * deflection, the two breach latches, and the two pause-aware durations — and
   * the outer aggregate counts and percentiles over them. Deflection is the one
   * that reaches past the Ticket: a terminal Ticket with no `user`-authored
   * Message *and* no `user`-authored Note, so an internal Note counts as the
   * agent touch it is and only genuine AI or self-service handling is credited.
   *
   * The group expression is drawn from a fixed table keyed by the validated
   * axis, never interpolated from the request, so this is `Prisma.raw` over a
   * constant rather than a SQL-injection seam. The assignee cut is applied here
   * rather than in the planner because "exclude deflected and unassigned" is a
   * statement about computed cohort columns, not about the request.
   */
  private aggregate(
    tx: TenantClient,
    plan: AnalyticsPlan,
    groupBy: GroupBy | undefined,
  ): Promise<AggregateRow[]> {
    const groupSelect = groupBy
      ? Prisma.sql`${GROUP_EXPR[groupBy]} AS "group_key",`
      : Prisma.sql`NULL::text AS "group_key",`;

    // Only the assignee cut narrows the cohort, and only for its own report:
    // "per-agent resolution rate" is inherently about agent-touched tickets, so
    // a deflected or unassigned Ticket has no agent to attribute to and is not
    // in any group.
    const cut =
      groupBy === 'assignee'
        ? Prisma.sql`WHERE "assignee_id" IS NOT NULL AND NOT deflected`
        : Prisma.empty;

    const grouping = groupBy
      ? Prisma.sql`GROUP BY "group_key" ORDER BY "group_key"`
      : Prisma.empty;

    return tx.$queryRaw<AggregateRow[]>`
      WITH cohort AS (
        SELECT
          t."priority",
          t."source",
          t."assignee_id",
          t."created_at",
          (t."state" IN ('resolved', 'closed')) AS resolved,
          (t."state" IN ('resolved', 'closed')
           AND NOT EXISTS (
             SELECT 1 FROM "message" m
              WHERE m."ticket_id" = t."id" AND m."author_kind" = 'user')
           AND NOT EXISTS (
             SELECT 1 FROM "note" n
              WHERE n."ticket_id" = t."id" AND n."author_kind" = 'user')
          ) AS deflected,
          (t."first_response_breached_at" IS NOT NULL) AS fr_breached,
          (t."resolution_breached_at" IS NOT NULL) AS res_breached,
          CASE WHEN t."first_response_at" IS NOT NULL
               THEN ticket_sla_wall_elapsed_ms(t."created_at", t."first_response_at")
          END AS fr_ms,
          -- Anchored at the terminal instant, sla_pause_started_at, which the
          -- state-machine trigger stamps on the move into resolved or closed --
          -- not at now(). The resolution clock stopped there, so this is the
          -- frozen active elapsed and the report is reproducible for a past
          -- window rather than a function of when it is run. The NOT NULL guard
          -- is the same fact stated defensively: a terminal Ticket always has
          -- the anchor by the ticket-08 invariant, and one that somehow did not
          -- would contribute NULL, excluded from the percentile, rather than an
          -- unbounded wall-clock figure.
          CASE WHEN t."state" IN ('resolved', 'closed')
                AND t."sla_pause_started_at" IS NOT NULL
               THEN ticket_sla_active_elapsed_ms(
                      t."created_at", t."sla_paused_ms",
                      t."sla_pause_started_at", t."sla_pause_started_at")
          END AS res_ms
          FROM "ticket" t
         WHERE t."created_at" >= ${plan.from} AND t."created_at" < ${plan.to}
      )
      SELECT
        ${groupSelect}
        COUNT(*) AS "cohort_size",
        COUNT(*) FILTER (WHERE deflected) AS "deflected",
        COUNT(*) FILTER (WHERE resolved) AS "resolved",
        COUNT(*) FILTER (WHERE fr_breached) AS "first_response_breached",
        COUNT(*) FILTER (WHERE res_breached) AS "resolution_breached",
        percentile_cont(0.5) WITHIN GROUP (ORDER BY fr_ms) AS "first_response_p50",
        percentile_cont(0.9) WITHIN GROUP (ORDER BY fr_ms) AS "first_response_p90",
        percentile_cont(0.5) WITHIN GROUP (ORDER BY res_ms) AS "resolution_p50",
        percentile_cont(0.9) WITHIN GROUP (ORDER BY res_ms) AS "resolution_p90"
        FROM cohort
        ${cut}
        ${grouping}
    `;
  }
}

/**
 * The group expression per axis, as trusted constant SQL.
 *
 * Keyed by the axis the planner already validated against a closed set, so the
 * only strings that reach `Prisma.raw` are these literals — the request never
 * does. `day` is the daily bucket, pinned to UTC so a report is deterministic
 * rather than a function of the server's session timezone, and formatted as a
 * date string so the key reads as the day it names.
 */
const GROUP_EXPR: Record<GroupBy, Prisma.Sql> = {
  priority: Prisma.raw('"priority"::text'),
  source: Prisma.raw('"source"::text'),
  assignee: Prisma.raw('"assignee_id"::text'),
  day: Prisma.raw(
    `to_char(("created_at" AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD')`,
  ),
};

/**
 * The wire shape of one aggregate row.
 *
 * Rates are formed here rather than in SQL: the counts are exact integers and
 * the ratio is a presentation choice, so dividing in TypeScript keeps the
 * numerator auditable and the `cohortSize === 0` case a `null` rather than a
 * division that Postgres would answer `NaN`.
 */
const toMetrics = (row: AggregateRow): MetricsDto => {
  const size = Number(row.cohort_size);

  return {
    cohortSize: size,
    deflection: rate(Number(row.deflected), size),
    resolution: rate(Number(row.resolved), size),
    firstResponseBreach: rate(Number(row.first_response_breached), size),
    resolutionBreach: rate(Number(row.resolution_breached), size),
    firstResponseMs: duration(row.first_response_p50, row.first_response_p90),
    resolutionMs: duration(row.resolution_p50, row.resolution_p90),
  };
};

const rate = (count: number, size: number): RateDto => ({
  count,
  rate: size === 0 ? null : count / size,
});

const duration = (
  p50: number | null,
  p90: number | null,
): DurationDto | null => (p50 === null || p90 === null ? null : { p50, p90 });

/**
 * The zero row an empty cohort yields.
 *
 * `COUNT(*)` over no rows is `0`, not no rows, so the ungrouped query always
 * returns one row and this is only reached defensively. It keeps `overall` a
 * `Metrics` rather than an optional, so a caller never branches on "was there
 * any data" — an empty tenant reports honest zeros.
 */
const emptyRow = (): AggregateRow => ({
  group_key: null,
  cohort_size: 0n,
  deflected: 0n,
  resolved: 0n,
  first_response_breached: 0n,
  resolution_breached: 0n,
  first_response_p50: null,
  first_response_p90: null,
  resolution_p50: null,
  resolution_p90: null,
});
