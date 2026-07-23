import { Module } from '@nestjs/common';
import { IdempotencyRetentionSweep } from './idempotency-retention.sweep';
import { IdempotencyService } from './idempotency.service';

/**
 * The idempotency primitive: a store, and the sweep that keeps it small.
 *
 * No controller, and no interceptor registration either. The interceptor is a
 * global provider in `GLOBAL_PROVIDERS` alongside the error filter and the
 * validation pipe, because it is a convention of the API surface rather than a
 * feature of this module — mounting it here would let a route escape it by not
 * importing anything.
 *
 * `IdempotencyService` is exported for both of its consumers: that interceptor,
 * and the inbound event dedupe that Slack ingestion builds on the same table. The
 * second one wants only `claim()`, with a scope of its own and no response to
 * cache, which is exactly why the service speaks in tenant contexts and scopes
 * rather than in requests and routes.
 *
 * The sweep is exported for `SchedulerModule` to compose into `SWEEPS`, the same
 * direction the SLA sweeps run: the scheduler knows what it drives, and this
 * module does not need to know it is driven.
 */
@Module({
  providers: [IdempotencyService, IdempotencyRetentionSweep],
  exports: [IdempotencyService, IdempotencyRetentionSweep],
})
export class IdempotencyModule {}
