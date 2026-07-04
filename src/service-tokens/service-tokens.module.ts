import { Module } from '@nestjs/common';
import { ServiceTokenModule } from './service-token.module';
import { ServiceTokensController } from './service-tokens.controller';

/**
 * The admin surface for machine credentials.
 *
 * Thin, because the interesting half is the credential itself and that lives in
 * `ServiceTokenModule` — which `AuthModule` imports directly. Splitting them is
 * what keeps the guard's dependency to "turn this bearer value into a
 * principal" rather than the whole feature.
 */
@Module({
  imports: [ServiceTokenModule],
  controllers: [ServiceTokensController],
})
export class ServiceTokensModule {}
