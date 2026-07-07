import { Module } from '@nestjs/common';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { HealthController } from './health.controller';

/**
 * Imports the scheduler for its heartbeat and nothing else. Readiness reports
 * on the ticker; it must never be able to start, stop, or drive one — a health
 * check with a side effect stops being an observation.
 *
 * The database reaches this through the global tenancy module, as everywhere.
 */
@Module({
  imports: [SchedulerModule],
  controllers: [HealthController],
})
export class HealthModule {}
