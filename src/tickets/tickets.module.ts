import { Module } from '@nestjs/common';
import { TicketService } from './ticket.service';
import { TicketsController } from './tickets.controller';

/**
 * The queue.
 *
 * `TenancyService` arrives from the global `TenancyModule`, so nothing is
 * imported here — and `TicketService` is exported because everything that
 * happens *to* a Ticket later (state transitions, messages, SLA clocks) reads
 * one first.
 */
@Module({
  controllers: [TicketsController],
  providers: [TicketService],
  exports: [TicketService],
})
export class TicketsModule {}
