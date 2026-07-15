import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import cookieParser from 'cookie-parser';
import { AccessTokenService } from './access-token.service';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { AuthService } from './auth.service';
import { GoogleOidcClient } from './google-client';
import { PasswordService } from './password.service';
import { RefreshTokenService } from './refresh-token.service';
import { PermissionGuard } from '../authz/permission.guard';
import { RateLimitGuard } from '../rate-limit/rate-limit.guard';
import { RateLimitModule } from '../rate-limit/rate-limit.module';
import { ServiceTokenModule } from '../service-tokens/service-token.module';
import { WidgetSessionModule } from '../widget/widget-session.module';

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
  // `WidgetSessionModule` is the guard's second verifier, and is deliberately
  // the *session* module rather than the whole `WidgetModule`: importing the
  // surface would drag the ticket and conversation stack in behind it, for a
  // dependency that is only ever "turn this bearer value into a principal".
  //
  // `ServiceTokenModule` is the third, on identical terms — the leaf that turns
  // a `nvk_live_` value into a principal, not the controller module that serves
  // the admin surface.
  //
  // `RateLimitModule` is the fourth, and is imported for the guard alone — the
  // ceiling it enforces has to be registered in the ordered chain below, and
  // this is the module that owns that ordering.
  imports: [
    JwtModule.register({}),
    WidgetSessionModule,
    ServiceTokenModule,
    RateLimitModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    AccessTokenService,
    RefreshTokenService,
    PasswordService,
    // The network seam for Google, provided here rather than in a module of its
    // own: it has exactly one consumer, and it is this module's controller.
    GoogleOidcClient,
    // Order matters and is load-bearing: Nest runs globally-scoped guards in
    // the order they are provided, and both guards below `AuthGuard` weigh a
    // principal it has to have resolved first. Declared adjacently, in one
    // module, so the ordering is a three-line invariant rather than a property
    // of how modules happen to be imported.
    //
    // `RateLimitGuard` sits between the two rather than after both. Refusing an
    // over-budget caller is the cheaper of the two remaining checks and the one
    // whose whole purpose is to avoid work, so it should not be queued behind a
    // permission lookup it may make unnecessary.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
  ],
  // `PasswordService` travels with the module that defines what a stored
  // credential looks like: accepting an invitation writes a hash this module's
  // sign-in has to verify, so both sides must use one configuration.
  //
  // `RefreshTokenService` is exported for the portal, which mints sessions for
  // Contacts out of the same ledger. Deliberately the same instance over the
  // same table rather than a portal copy: rotation and replay detection are the
  // parts of a session that must not exist twice, because two implementations
  // of "has this token been spent" is one implementation that eventually says no
  // when the other says yes.
  exports: [AccessTokenService, PasswordService, RefreshTokenService],
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
