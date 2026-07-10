import { Module } from '@nestjs/common';
import { JobQueueService } from './job-queue.service';

/**
 * The queue's data access, on its own.
 *
 * Split out of `SchedulerModule` when the Slack adapter arrived, and the reason
 * is a dependency cycle that is worth understanding rather than working around
 * with `forwardRef`. `SchedulerModule` has to know the *handlers*, so it depends
 * on every adapter; an adapter has to *enqueue*, so it depended back. That is a
 * genuine cycle only because one module was doing two jobs.
 *
 * The split names them. Enqueueing is a thing features do, and it needs nothing
 * but a transaction — `JobQueueService`'s own comment already said as much: "the
 * queue's data access, and nothing else". Draining is a runtime, and it needs the
 * handlers. So features depend on this module, the runtime depends on this module
 * and on the features, and the graph is a tree again.
 *
 * `SchedulerModule` re-exports `JobQueueService`, so nothing that imported it for
 * the queue had to change.
 */
@Module({
  providers: [JobQueueService],
  exports: [JobQueueService],
})
export class JobQueueModule {}
