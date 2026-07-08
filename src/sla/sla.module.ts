import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { DwellSweep } from './dwell.sweep';
import { SlaBreachSweep } from './sla-breach.sweep';

/**
 * Two sweeps carrying three time-driven effects, and nothing else.
 *
 * No controller, and that omission is the v1 SLA policy stated in code: the
 * target matrix is fixed and seeded identically for every tenant, so there is
 * nothing to configure and no endpoint to configure it through. `app_user` holds
 * only `SELECT` on `sla_target`, so this is not merely a route that was left
 * unwritten.
 *
 * The clocks themselves are not here either. Pause accumulation and the
 * first-response stamp are maintained by triggers, so they hold for every writer
 * through every port rather than for whichever service remembered to call this
 * module. What is left in TypeScript is the part a trigger cannot do: notice
 * that time has passed with nothing happening.
 *
 * The sweeps are exported for `SchedulerModule`, which composes them into the
 * `SWEEPS` registry. The dependency runs that way round on purpose — the
 * scheduler knows what it drives, and the SLA work does not need to know it is
 * driven by a scheduler at all.
 */
@Module({
  imports: [AuditModule, RealtimeModule],
  providers: [SlaBreachSweep, DwellSweep],
  exports: [SlaBreachSweep, DwellSweep],
})
export class SlaModule {}
