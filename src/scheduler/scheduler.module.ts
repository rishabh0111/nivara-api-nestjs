import { Module } from '@nestjs/common';
import { DwellSweep } from '../sla/dwell.sweep';
import { SlaBreachSweep } from '../sla/sla-breach.sweep';
import { SlaModule } from '../sla/sla.module';
import { DrainerService } from './drainer.service';
import { EMPTY_REGISTRY, JOB_HANDLERS } from './job-handler';
import { JobQueueService } from './job-queue.service';
import { SchedulerHeartbeat } from './scheduler-heartbeat';
import { SchedulerTicker } from './scheduler-ticker.service';
import { SWEEPS, SweeperService } from './sweeper.service';

/**
 * The queue, the two ticks, and the clock that drives them.
 *
 * Three things leave this module, and the omissions are the design. `JobQueue`
 * is exported because features enqueue work; the two tick services are exported
 * because tests drive them directly, and because a future admin surface may want
 * to run one on demand. `SchedulerTicker` is exported nowhere — nothing should
 * be able to start, stop, or reach past the clock, which is the piece each port
 * replaces.
 *
 * The heartbeat is exported for readiness alone. It is a fact this process holds
 * about itself, and the health surface is the only legitimate reader.
 *
 * Both registries are provided by token, and the seam paid off as intended: the
 * SLA work arrived as the two registrations below and changed not one line of
 * the tick. The job-handler registry is still empty and fills the same way when
 * the Slack adapter lands.
 */
@Module({
  imports: [SlaModule],
  providers: [
    { provide: JOB_HANDLERS, useValue: EMPTY_REGISTRY },
    {
      // Order is the order they run in, and it is the order that reads right:
      // breaches are latched against the states Tickets are in now, before the
      // dwell timers move any of them. The reverse would let a Ticket be
      // resolved by dwell in the same tick that its resolution clock ran out,
      // and whether it breached would depend on which sweep went first.
      provide: SWEEPS,
      useFactory: (breach: SlaBreachSweep, dwell: DwellSweep) => [
        breach,
        dwell,
      ],
      inject: [SlaBreachSweep, DwellSweep],
    },
    JobQueueService,
    DrainerService,
    SweeperService,
    SchedulerHeartbeat,
    SchedulerTicker,
  ],
  exports: [
    JobQueueService,
    DrainerService,
    SweeperService,
    SchedulerHeartbeat,
  ],
})
export class SchedulerModule {}
