import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { WidgetSessionModule } from '../widget/widget-session.module';
import { EventLog } from './event-log';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeService } from './realtime.service';

/**
 * The socket surface, and the emit API the rest of the application uses.
 *
 * Imports the two *credential* modules and neither surface module, which is the
 * same line `WidgetSessionModule` and `ServiceTokenModule` were split along:
 * this needs to turn a bearer value into a principal, and needs nothing else
 * from either feature. It matters more here than elsewhere, because the modules
 * that emit — tickets, conversation — import *this* one, so reaching for
 * `TicketsModule` to answer the requester check would have closed a cycle
 * immediately. The check goes to the database directly instead, which is the
 * better answer anyway: row-level security owns row ownership.
 *
 * `EventLog` is provided here and exported nowhere. Sequencing is an
 * implementation detail of the socket, and a second consumer appending to it
 * would be a second author of a room's ordering. It comes from a factory rather
 * than `useClass` because its constructor takes bounds, not collaborators —
 * there is nothing there for the container to resolve.
 */
@Module({
  imports: [AuthModule, WidgetSessionModule],
  providers: [
    { provide: EventLog, useFactory: () => new EventLog() },
    RealtimeGateway,
    RealtimeService,
  ],
  // Only the emit API leaves. A feature with news calls a method named after
  // the event; it cannot reach the gateway, choose a room, or build an envelope.
  exports: [RealtimeService],
})
export class RealtimeModule {}
