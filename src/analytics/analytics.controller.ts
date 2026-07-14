import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Principal } from '../auth/principal.decorator';
import { RequestPrincipal } from '../auth/request-principal';
import { RequiresPermission } from '../authz/require-permission.decorator';
import { ApiErrorResponses } from '../common/errors/api-error-responses.decorator';
import { planAnalytics } from './analytics-query';
import { AnalyticsService } from './analytics.service';
import { AnalyticsQueryDto } from './dto/analytics-query.dto';
import { AnalyticsReportDto } from './dto/analytics.dto';

/**
 * The tenant's numbers.
 *
 * One read, gated on `analytics:read` — a grant agents and admins hold, and one
 * of the assignable service-token scopes, so the AI layer pulls its own figures
 * under the same guard rather than through a back door. A Contact or a widget
 * session holds no analytics grant and never reaches here.
 *
 * The whole surface is this one aggregate endpoint. There is deliberately no
 * route that returns a Ticket or a row: analytics answers "how are we doing",
 * and "which tickets" is the ticket API's question, with its pagination and its
 * PII. Keeping the two apart is what stops this becoming a data-export surface.
 */
@ApiTags('analytics')
@ApiBearerAuth()
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get()
  @RequiresPermission('analytics:read')
  @ApiOperation({
    summary: 'The tenant’s live support metrics over a cohort',
    description:
      'Four headline rates — deflection, resolution, and the two SLA breach rates — over one shared cohort of Tickets created in `[from, to)`, defaulting to the last 30 days and anchored on creation time. First-response and resolution durations are reported at p50 and p90. An optional `groupBy` breaks every figure down by priority, source, assignee, or day; the assignee cut excludes deflected and unassigned Tickets. Everything is computed live as tenant-scoped SQL — never stale, and never able to cross tenants.',
  })
  @ApiOkResponse({ type: AnalyticsReportDto })
  @ApiErrorResponses('invalid_filter', 'unauthenticated', 'forbidden')
  async report(
    @Principal() principal: RequestPrincipal,
    @Query() query: AnalyticsQueryDto,
  ): Promise<AnalyticsReportDto> {
    return this.analytics.report(principal, planAnalytics(query));
  }
}
