import { Module } from '@nestjs/common';
import { RedisService } from './redis.service';

/**
 * The shared Redis connection, as a module of its own.
 *
 * Separate from the one consumer it has today because it is about to have two:
 * the cache seam shares this client rather than opening a second. A module that
 * provides one connection and nothing else is what makes that sharing a matter
 * of importing it, instead of one feature reaching into another's internals.
 */
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
