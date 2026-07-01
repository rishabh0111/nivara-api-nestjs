import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { AuthModule } from '../auth/auth.module';
import { ConversationModule } from '../conversation/conversation.module';
import { TicketsModule } from '../tickets/tickets.module';
import { PortalAuthController } from './portal-auth.controller';
import { PortalAuthService } from './portal-auth.service';
import { PortalTicketsController } from './portal-tickets.controller';

/**
 * The customer-facing half of the API.
 *
 * Composed almost entirely out of other modules' services, which is the shape
 * the ticket asks for: a Contact's access is a different *axis*, not a different
 * implementation. Tickets and Messages behave identically whoever asks for them,
 * and the narrowing to "mine" happens in the row-level security policies beneath
 * both surfaces. What this module actually owns is one service —
 * authenticating a Contact — and a decision about which operations exist.
 *
 * `NoteService` is not imported and could not be: `ConversationModule` does not
 * export it. That is the module-level statement of the same guarantee the
 * separate tables and the policy make.
 */
@Module({
  imports: [AuthModule, TicketsModule, ConversationModule],
  controllers: [PortalAuthController, PortalTicketsController],
  providers: [PortalAuthService],
})
export class PortalModule implements NestModule {
  /**
   * Cookie parsing for the portal's own routes.
   *
   * `AuthModule` scopes its middleware to `auth`, which does not cover
   * `portal/auth` — so the portal registers its own rather than widening the
   * staff one to every route that happens to end in the same word. Without it
   * the refresh cookie is never parsed and every portal refresh answers 401,
   * which is a failure that looks exactly like an expired session.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(cookieParser()).forRoutes('portal/auth');
  }
}
