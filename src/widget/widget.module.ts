import { Module } from '@nestjs/common';
import { ConversationModule } from '../conversation/conversation.module';
import { TicketsModule } from '../tickets/tickets.module';
import { WidgetSessionModule } from './widget-session.module';
import { WidgetSessionsController } from './widget-sessions.controller';
import { WidgetTicketsController } from './widget-tickets.controller';

/**
 * The anonymous customer-facing surface.
 *
 * Composed almost entirely out of other modules' services, exactly as
 * `PortalModule` is, and the shared shape is the point: a widget visitor is a
 * different *credential*, not a different implementation. Tickets and Messages
 * behave identically whoever asks for them, and the narrowing to "mine" happens
 * in the row-level security policies beneath every surface. What this module
 * owns is one service — minting and resolving sessions — and a decision about
 * which operations exist.
 *
 * `NoteService` is not imported and could not be: `ConversationModule` does not
 * export it. Same module-level statement of the same guarantee the separate
 * tables and the contact-axis policy make, now for a third surface.
 *
 * Note also what is *not* here: no cookie middleware. The portal registers one
 * because its refresh token lives in an httpOnly cookie; the widget runs on the
 * tenant's own origin, where a cookie from this API would be third-party and
 * dropped, so its credential is a bearer token and there is nothing to parse.
 */
@Module({
  imports: [WidgetSessionModule, TicketsModule, ConversationModule],
  controllers: [WidgetSessionsController, WidgetTicketsController],
})
export class WidgetModule {}
