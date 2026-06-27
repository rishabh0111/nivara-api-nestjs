import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { TicketService } from './ticket.service';
import { TicketsController } from './tickets.controller';

/**
 * The queue.
 *
 * `TenancyService` arrives from the global `TenancyModule`, so only `AuditModule`
 * is imported here — opening a Ticket is a control-plane change and says so in
 * the log. `TicketService` is exported because everything that happens *to* a
 * Ticket later (state transitions, messages, SLA clocks) reads one first.
 */
@Module({
  imports: [AuditModule],
  controllers: [TicketsController],
  providers: [TicketService],
  exports: [TicketService],
})
export class TicketsModule {}
