import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { AppConfigService } from '../config/app-config.service';
import { PrismaClient } from '../generated/prisma/client';

/**
 * The database client, as a Nest provider.
 *
 * The connection string comes from validated configuration rather than from
 * `process.env` — which matters more here than elsewhere, because *which*
 * credential this client holds is the whole tenant-isolation guarantee. It is
 * always `DATABASE_URL`: the least-privileged, non-`BYPASSRLS` `app_user` over
 * the pooled endpoint. The owner credential is a separate variable that the
 * running process never sees (see `env.schema.ts`).
 *
 * Nothing outside `src/tenancy` should inject this directly. Queries go through
 * `TenancyService.withTenant()`, which is what arms the policies — a query
 * issued on this client with no transaction around it sees no rows at all.
 */
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  constructor(config: AppConfigService) {
    super({
      adapter: new PrismaPg({ connectionString: config.databaseUrl }),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
