import { Module } from '@nestjs/common';
import { OutboundModule } from '../outbound/outbound.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { TicketsModule } from '../tickets/tickets.module';
import { ContactReplyService } from './contact-reply.service';
import { MessageService } from './message.service';
import { MessagesController } from './messages.controller';
import { NoteService } from './note.service';
import { NotesController } from './notes.controller';

/**
 * What is said on a Ticket, in two kinds that never meet.
 *
 * One module holding two deliberately separate halves: they share a shape and a
 * route prefix, so keeping them apart at the module level would only scatter
 * the reasoning. The separation that matters is the one below them — two
 * tables, two services, two controllers — and it does not depend on this.
 *
 * `AuditModule` is conspicuously not imported. Posting a Message is not a
 * control-plane change, and Message and Note content never enters the audit
 * log: conversation is domain data attributed on its own rows. The state
 * changes a message *causes* are audited by whatever makes them.
 *
 * `TenancyService` arrives from the global `TenancyModule`.
 *
 * `MessageService` is exported and `NoteService` is emphatically not. The portal
 * serves a Contact its own customer-visible thread and needs the first; nothing
 * outside this module has any business holding the second, and the export list
 * is where that stops being a convention. A future surface that wants Notes has
 * to add itself here, in a diff a reviewer sees.
 *
 * `TicketsModule` arrived with ticket 10, and the direction of that dependency
 * is the design: a Contact's reply can reopen or spawn a Ticket, so conversation
 * knows about tickets and tickets know nothing about conversation. The reverse
 * edge is what a Message hook inside the state machine would have created, and
 * it would have put reply semantics in the middle of the queue.
 *
 * `RealtimeModule` is imported directly rather than leaned on through
 * `TicketsModule`, even though that module already has it. Both halves of this
 * one announce on their own terms — a Message into the Ticket's customer-visible
 * room, a Note into the `:internal` room beside it — so the dependency is this
 * module's own, and inheriting it transitively would make it disappear the day
 * the queue stopped needing it.
 *
 * `ContactReplyService` is exported for the portal and, since ticket 17, for
 * Slack ingestion — which joined on exactly the terms predicted, differing only
 * in the Source it passes. A customer replying in a Slack thread and one replying
 * in the portal get the same reopen, the same spawn and the same one-live-per-
 * chain guarantee because they run the same method.
 *
 * `OutboundModule` is the edge that arrived with that ticket, and its direction
 * is the design. Posting a Message now schedules its delivery to wherever the
 * conversation is reachable — but this module imports the *pipe*, not the Slack
 * adapter, so nothing here knows what a channel is. The reverse edge, a
 * conversation service importing an adapter, is what would have made every future
 * channel an edit to this file.
 */
@Module({
  imports: [TicketsModule, RealtimeModule, OutboundModule],
  controllers: [MessagesController, NotesController],
  providers: [ContactReplyService, MessageService, NoteService],
  exports: [ContactReplyService, MessageService],
})
export class ConversationModule {}
