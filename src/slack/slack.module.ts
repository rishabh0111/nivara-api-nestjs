import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ConversationModule } from '../conversation/conversation.module';
import { IdempotencyModule } from '../idempotency/idempotency.module';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { SlackRateLimitMiddleware } from '../rate-limit/slack-rate-limit.middleware';
import { RealtimeModule } from '../realtime/realtime.module';
import { JobQueueModule } from '../scheduler/job-queue.module';
import { TicketsModule } from '../tickets/tickets.module';
import { SlackClient } from './slack-client';
import { SlackDeliveryService } from './slack-delivery.service';
import { SlackEventsController } from './slack-events.controller';
import { SlackInboundService } from './slack-inbound.service';
import { SlackIngestionService } from './slack-ingestion.service';
import { SlackInstallationService } from './slack-installation.service';

/**
 * A source adapter, whole: one route in, one client out, and two job handlers
 * between them.
 *
 * Nearly everything Slack-specific in this system is in this directory, and the
 * way to check that claim is to read the imports. Every one of them is a
 * primitive that existed before this ticket — the queue, the dedupe store, the
 * conversation services, the audit log, the socket — and not one of them learned
 * a Slack case in order to be used here.
 *
 * The exceptions are worth naming rather than glossing, because a claim of
 * containment is only useful if it is exact. `slack` appears in the `TicketSource`
 * enum; in two nullable columns on `Ticket` and their inheritance trigger; and in
 * `OutboundDispatchService.routeFor`, which reads those columns to decide where a
 * reply is owed. That last one is the real seam, and it is where a second channel
 * will force a registry — see the comment there for why one entry does not yet
 * justify the machinery. Everything else is in this folder, including the
 * destination format, which lives in `slack-target.ts` precisely so the dispatch
 * side can serialize a Slack address without importing this module.
 *
 * The three services divide along the two things that can go wrong. Verification
 * and acknowledgement are a request that must finish in three seconds and must
 * refuse anything unproven; ingestion and delivery are work that may fail against
 * a third party and must survive a restart. Splitting them is what lets the first
 * be tested without a queue and the second without an HTTP request.
 *
 * `SlackClient` is the network, alone, so a test replaces one provider and
 * exercises the rest against a real database.
 *
 * Nothing is exported but the two handlers, and those go to `SchedulerModule`
 * through the registry rather than to a caller. There is no service here that
 * another feature has any reason to hold: an adapter is something the outside
 * world talks to, not something the domain talks through.
 */
@Module({
  imports: [
    JobQueueModule,
    IdempotencyModule,
    ConversationModule,
    TicketsModule,
    RealtimeModule,
    AuditModule,
    RateLimitModule,
  ],
  controllers: [SlackEventsController],
  providers: [
    SlackClient,
    SlackDeliveryService,
    SlackInboundService,
    SlackIngestionService,
    SlackInstallationService,
  ],
  exports: [SlackDeliveryService, SlackIngestionService],
})
export class SlackModule implements NestModule {
  /**
   * The pre-trust ceiling, mounted on this adapter's route.
   *
   * Registered here rather than in `RateLimitModule` because this is the module
   * that knows which path it is protecting — a limiter module naming
   * `integrations/slack` would have to know about a feature it otherwise has no
   * relationship with. It follows the precedent `AuthModule` set with cookie
   * parsing: a middleware travels with the module whose routes depend on it, so
   * a test booting the application gets the same protection production does.
   *
   * Middleware, so it runs before the guard chain and therefore before the
   * signature check inside the handler. That ordering is the acceptance
   * criterion — a flood must be turned away before any HMAC is computed and
   * before anything is enqueued — and it is why this is not a guard.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(SlackRateLimitMiddleware).forRoutes(SlackEventsController);
  }
}
