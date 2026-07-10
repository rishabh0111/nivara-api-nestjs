import { Module } from '@nestjs/common';
import { IdempotencyRetentionSweep } from '../idempotency/idempotency-retention.sweep';
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { DwellSweep } from '../sla/dwell.sweep';
import { SlaBreachSweep } from '../sla/sla-breach.sweep';
import { SlaModule } from '../sla/sla.module';
import {
  INBOUND_EVENT_JOB,
  OUTBOUND_DELIVERY_JOB,
} from '../integrations/job-kinds';
import { SlackDeliveryService } from '../slack/slack-delivery.service';
import { SlackIngestionService } from '../slack/slack-ingestion.service';
import { SlackModule } from '../slack/slack.module';
import { DrainerService } from './drainer.service';
import { JOB_HANDLERS, JobHandlerRegistry } from './job-handler';
import { JobQueueModule } from './job-queue.module';

import { SchedulerHeartbeat } from './scheduler-heartbeat';
import { SchedulerTicker } from './scheduler-ticker.service';
import { SWEEPS, SweeperService } from './sweeper.service';

/**
 * The two ticks, the clock that drives them, and what they run.
 *
 * The queue itself moved out to `JobQueueModule` when the Slack adapter arrived —
 * see there for why, but the short version is that this module had grown two jobs
 * and only one of them belonged in a cycle. Features enqueue against that module;
 * `JobQueueService` is re-exported here so nothing that imported it had to move.
 *
 * The two tick services are exported because tests drive them directly, and
 * because a future admin surface may want to run one on demand. `SchedulerTicker`
 * is exported nowhere — nothing should be able to start, stop, or reach past the
 * clock, which is the piece each port replaces.
 *
 * The heartbeat is exported for readiness alone. It is a fact this process holds
 * about itself, and the health surface is the only legitimate reader.
 *
 * Both registries are provided by token, and the seam has now paid off twice. The
 * SLA work arrived as two sweep registrations and changed not one line of the
 * tick; the Slack adapter arrived as two handler registrations and changed not
 * one line of the drainer. Neither the claim nor the settle knows that either
 * exists.
 */
@Module({
  imports: [SlaModule, IdempotencyModule, SlackModule, JobQueueModule],
  providers: [
    {
      // The registry filling exactly as the seam predicted: two entries, and not
      // one line of the drainer, the claim or the tick changed to accept them.
      // `EMPTY_REGISTRY` stays exported for the ports and for tests that want a
      // runtime with nothing registered.
      //
      // Both kinds come from the Slack adapter today and neither is named after
      // it, which is the shape to keep: `inbound.event` and `outbound.delivery`
      // are what *every* source adapter produces, so a second one registers
      // alongside these rather than inventing a third and fourth kind.
      provide: JOB_HANDLERS,
      useFactory: (
        ingestion: SlackIngestionService,
        delivery: SlackDeliveryService,
      ): JobHandlerRegistry =>
        Object.freeze({
          [INBOUND_EVENT_JOB]: ingestion.handle,
          [OUTBOUND_DELIVERY_JOB]: delivery.handle,
        }),
      inject: [SlackIngestionService, SlackDeliveryService],
    },
    {
      // Order is the order they run in, and it is the order that reads right:
      // breaches are latched against the states Tickets are in now, before the
      // dwell timers move any of them. The reverse would let a Ticket be
      // resolved by dwell in the same tick that its resolution clock ran out,
      // and whether it breached would depend on which sweep went first.
      //
      // Idempotency retention goes last and could go anywhere: it is pure
      // housekeeping over a table the other two never read, so nothing it does
      // can change what they see. That independence is worth noting rather than
      // relying on silently — the first sweep whose order *does* matter should
      // have to argue for its position.
      provide: SWEEPS,
      useFactory: (
        breach: SlaBreachSweep,
        dwell: DwellSweep,
        retention: IdempotencyRetentionSweep,
      ) => [breach, dwell, retention],
      inject: [SlaBreachSweep, DwellSweep, IdempotencyRetentionSweep],
    },
    DrainerService,
    SweeperService,
    SchedulerHeartbeat,
    SchedulerTicker,
  ],
  exports: [
    // The *module*, not the provider. `JobQueueService` is no longer one of this
    // module's own providers, so re-exporting it by name is not something Nest
    // can honour — exporting the module it does belong to is, and it keeps the
    // promise that nothing which imported `SchedulerModule` for the queue had to
    // move when the two were separated.
    JobQueueModule,
    DrainerService,
    SweeperService,
    SchedulerHeartbeat,
  ],
})
export class SchedulerModule {}
