import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { RateLimitGuard } from './rate-limit.guard';
import { RateLimitService } from './rate-limit.service';
import { SlackRateLimitMiddleware } from './slack-rate-limit.middleware';

/**
 * Both ceilings, and the counter they share.
 *
 * The guard and the middleware are exported rather than registered here, and
 * that is deliberate in each case. `RateLimitGuard` has to be provided as an
 * `APP_GUARD` *adjacent to* `AuthGuard`, because Nest runs globally-scoped
 * guards in provider order and this one reads a principal that guard resolves —
 * so the ordering stays a few lines in one module rather than a property of how
 * `AppModule` happens to list its imports. `SlackRateLimitMiddleware` is
 * registered by `SlackModule`, which is the module that knows the route it
 * guards; a middleware registered here would mean this module had to name a
 * path belonging to a feature it otherwise knows nothing about.
 *
 * `RateLimitService` is exported for a less obvious reason. `AuthModule`
 * registers the guard with `useClass`, so Nest constructs it in *that* module's
 * injector rather than this one, and its dependencies have to be resolvable
 * there. Exporting the counter is what makes that work — and it is a standing
 * reason to keep the guard's constructor as narrow as it is, since every
 * dependency it gains has to be exported from here as well.
 */
@Module({
  imports: [RedisModule],
  providers: [RateLimitService, RateLimitGuard, SlackRateLimitMiddleware],
  exports: [RateLimitService, RateLimitGuard, SlackRateLimitMiddleware],
})
export class RateLimitModule {}
