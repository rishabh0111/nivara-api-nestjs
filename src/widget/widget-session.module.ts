import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { WidgetSessionService } from './widget-session.service';

/**
 * The credential half of the widget, on its own so the guard can reach it.
 *
 * Split from `WidgetModule` for one concrete reason: `AuthGuard` resolves widget
 * tokens and therefore needs `WidgetSessionService`, while `WidgetModule` needs
 * `TicketsModule` and `ConversationModule` to serve its routes. Fused, importing
 * the guard's dependency would drag the entire ticket and conversation stack
 * into `AuthModule` — and would close a cycle the moment either of those ever
 * wants something from auth.
 *
 * The split follows the same line service tokens will: what
 * *verifies a credential* is a leaf, and what *serves a surface* is not.
 */
@Module({
  imports: [JwtModule.register({})],
  providers: [WidgetSessionService],
  exports: [WidgetSessionService],
})
export class WidgetSessionModule {}
