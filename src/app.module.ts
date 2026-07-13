import { Module } from '@nestjs/common';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { CacheModule } from './cache/cache.module';
import { GLOBAL_PROVIDERS } from './common/global-providers';
import { ConversationModule } from './conversation/conversation.module';
import { AppConfigModule } from './config/app-config.module';
import { HealthModule } from './health/health.module';
import { IdempotencyModule } from './idempotency/idempotency.module';
import { MetaModule } from './meta/meta.module';
import { OutboundModule } from './outbound/outbound.module';
import { PortalModule } from './portal/portal.module';
import { SlackModule } from './slack/slack.module';
import { RealtimeModule } from './realtime/realtime.module';
import { SchedulerModule } from './scheduler/scheduler.module';
import { ServiceTokensModule } from './service-tokens/service-tokens.module';
import { StaffModule } from './staff/staff.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { TicketsModule } from './tickets/tickets.module';
import { WidgetModule } from './widget/widget.module';

@Module({
  imports: [
    AppConfigModule,
    TenancyModule,
    CacheModule,
    IdempotencyModule,
    AuthModule,
    StaffModule,
    TicketsModule,
    ConversationModule,
    PortalModule,
    WidgetModule,
    RealtimeModule,
    ServiceTokensModule,
    OutboundModule,
    SlackModule,
    SchedulerModule,
    AuditModule,
    HealthModule,
    MetaModule,
  ],
  providers: [...GLOBAL_PROVIDERS],
})
export class AppModule {}
