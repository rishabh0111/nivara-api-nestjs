import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import cookieParser from 'cookie-parser';
import { AccessTokenService } from './access-token.service';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { PasswordService } from './password.service';
import { RefreshTokenService } from './refresh-token.service';

/**
 * Authentication, and the guard that closes the application by default.
 *
 * `AuthGuard` is registered as an `APP_GUARD` here rather than in
 * `GLOBAL_PROVIDERS`, because unlike the conventions there it needs this
 * module's providers. The effect is the same and it is the important one:
 * every route is authenticated unless it carries `@Public()`, so a new
 * controller is protected by default and exposure takes a deliberate edit.
 *
 * `AccessTokenService` is exported because the WebSocket gateway authenticates
 * at connect with the same token and must resolve it the same way — a second
 * verifier would be a second place for the claim checks to drift.
 */
@Module({
  imports: [JwtModule.register({})],
  controllers: [AuthController],
  providers: [
    AuthService,
    AccessTokenService,
    RefreshTokenService,
    PasswordService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [AccessTokenService],
})
export class AuthModule implements NestModule {
  /**
   * Cookie parsing, scoped to the routes that read a cookie.
   *
   * Registered here rather than in `main.ts` so it travels with the module
   * that depends on it: a test booting the application gets the same parsing
   * production does, instead of passing or failing on whether the harness
   * remembered to install a middleware.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(cookieParser()).forRoutes('auth');
  }
}
