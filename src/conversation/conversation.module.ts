import { Module } from '@nestjs/common';
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
 * `TenancyService` arrives from the global `TenancyModule`. Nothing is exported
 * — the SLA clocks and realtime fan-out that will care about Messages arriving
 * are later tickets, and they should take the seam they need rather than the
 * one guessed for them now.
 */
@Module({
  controllers: [MessagesController, NotesController],
  providers: [MessageService, NoteService],
})
export class ConversationModule {}
