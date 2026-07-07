import { Module } from '@nestjs/common';
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
 * Both registries are provided empty and by token. The job kinds this queue was
 * built for arrive with the Slack adapter, and the sweeps with the SLA work;
 * providing the seams now — rather than the stubs — is what lets those land as
 * registrations instead of edits to the loop.
 */
@Module({
  providers: [
    { provide: JOB_HANDLERS, useValue: EMPTY_REGISTRY },
    { provide: SWEEPS, useValue: [] },
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
