import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { TenancyService } from './tenancy.service';

/**
 * Database access, and the only sanctioned way to reach it.
 *
 * Global because every tenant-scoped feature needs `withTenant()` and none of
 * them should be able to reach the database any other way. `PrismaService` is
 * exported too, but only for work that legitimately has no tenant to run under
 * — so far nothing in the application does, and the isolation tests are its
 * only consumer.
 */
@Global()
@Module({
  providers: [PrismaService, TenancyService],
  exports: [PrismaService, TenancyService],
})
export class TenancyModule {}
