import { Module } from '@nestjs/common';
import { RedisModule } from '../redis/redis.module';
import { CacheService } from './cache.service';

/**
 * The cache seam, wired to the Redis connection rate limiting already owns.
 *
 * Registered in `AppModule` despite having no consumers in v1. A provider
 * nobody injects is not dead weight here: importing it is what proves the seam
 * resolves from the shared `RedisModule` rather than needing a connection of
 * its own, and it means the first cached read is an injection rather than an
 * injection plus a module graph change.
 */
@Module({
  imports: [RedisModule],
  providers: [CacheService],
  exports: [CacheService],
})
export class CacheModule {}
