import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { SchedulerModule } from '../scheduler/scheduler.module';
import { HealthController } from './health.controller';

/**
 * Imports the scheduler for its heartbeat and nothing else. Readiness reports
 * on the ticker; it must never be able to start, stop, or drive one — a health
 * check with a side effect stops being an observation.
 *
 * Redis arrives on the same terms: the shared client, for one `PING`. Importing
 * the module rather than reading `REDIS_URL` from configuration is what makes
 * the reported status a fact about the connection the request path uses, not
 * about a string.
 *
 * The database reaches this through the global tenancy module, as everywhere.
 */
@Module({
  imports: [SchedulerModule, RedisModule],
  controllers: [HealthController],
})
export class HealthModule {}
