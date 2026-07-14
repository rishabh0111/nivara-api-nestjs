import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';

/**
 * The reporting read, and nothing else.
 *
 * One controller, one service, no exports: nothing in the application composes
 * on analytics, because a metric is a leaf — it is read by a client, never by
 * another service that would then depend on how a number is defined.
 *
 * `TenancyService` arrives from the global `TenancyModule`, which is the only
 * dependency this feature has. `AuditModule` is conspicuously absent: reading
 * numbers changes nothing, so there is no control-plane act to record. It reads
 * `message` and `note` for the deflection predicate but imports neither module
 * — it aggregates their rows in SQL rather than calling their services, which is
 * exactly the coupling a metric should not have.
 */
@Module({
  controllers: [AnalyticsController],
  providers: [AnalyticsService],
})
export class AnalyticsModule {}
