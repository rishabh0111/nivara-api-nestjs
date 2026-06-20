import { Module } from '@nestjs/common';
import { GLOBAL_PROVIDERS } from './common/global-providers';
import { AppConfigModule } from './config/app-config.module';
import { HealthModule } from './health/health.module';
import { MetaModule } from './meta/meta.module';

@Module({
  imports: [AppConfigModule, HealthModule, MetaModule],
  providers: [...GLOBAL_PROVIDERS],
})
export class AppModule {}
