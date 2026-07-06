import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RealtimeModule } from '../realtime/realtime.module';
import { TicketService } from './ticket.service';
import { TicketsController } from './tickets.controller';

/**
 * The queue.
 *
 * `TenancyService` arrives from the global `TenancyModule`, so only `AuditModule`
 * is imported here — opening a Ticket is a control-plane change and says so in
 * the log. `TicketService` is exported because everything that happens *to* a
 * Ticket later (state transitions, messages, SLA clocks) reads one first.
 *
 * `RealtimeModule` arrived with ticket 13, and the direction of that dependency
 * is the design: the queue announces what it did, and the socket knows nothing
 * about tickets. The reverse edge is what a `TicketService` inside the gateway
 * would have created — and it would have put the queue in the middle of a
 * subscribe, which is why the gateway's one row-ownership question goes to the
 * database instead.
 */
@Module({
  imports: [AuditModule, RealtimeModule],
  controllers: [TicketsController],
  providers: [TicketService],
  exports: [TicketService],
})
export class TicketsModule {}
