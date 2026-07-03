import { Module } from '@nestjs/common';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { GLOBAL_PROVIDERS } from './common/global-providers';
import { ConversationModule } from './conversation/conversation.module';
import { AppConfigModule } from './config/app-config.module';
import { HealthModule } from './health/health.module';
import { MetaModule } from './meta/meta.module';
import { PortalModule } from './portal/portal.module';
import { StaffModule } from './staff/staff.module';
import { TenancyModule } from './tenancy/tenancy.module';
import { TicketsModule } from './tickets/tickets.module';
import { WidgetModule } from './widget/widget.module';

@Module({
  imports: [
    AppConfigModule,
    TenancyModule,
    AuthModule,
    StaffModule,
    TicketsModule,
    ConversationModule,
    PortalModule,
    WidgetModule,
    AuditModule,
    HealthModule,
    MetaModule,
  ],
  providers: [...GLOBAL_PROVIDERS],
})
export class AppModule {}
