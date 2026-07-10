import { Module } from '@nestjs/common';
import { JobQueueModule } from '../scheduler/job-queue.module';
import { OutboundDispatchService } from './outbound-dispatch.service';

/**
 * The pipe out of Nivara, with no idea what is at the far end.
 *
 * Deliberately its own module rather than a service inside the Slack adapter, and
 * the import list is the argument: it knows about the queue and about nothing
 * else. No Slack client, no signature scheme, no HTTP. What it produces is a row
 * saying "this Message is owed to this destination" and a job saying somebody
 * should see to it — and *which* somebody is decided later, by a string on the
 * row, in a module this one has never heard of.
 *
 * That is what keeps `ConversationModule`'s new dependency honest. Posting a
 * Message now schedules a delivery, and `MessageService` imports this rather than
 * the Slack adapter, so the conversation half of the domain remains ignorant of
 * every channel — which is the property that has to hold when the second channel
 * arrives.
 */
@Module({
  imports: [JobQueueModule],
  providers: [OutboundDispatchService],
  exports: [OutboundDispatchService],
})
export class OutboundModule {}
