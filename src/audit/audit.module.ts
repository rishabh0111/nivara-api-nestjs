import { Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

/**
 * The append-only record.
 *
 * `AuditService` is exported because writing history is something other modules
 * do as part of their own work — a Ticket being created, a token being minted —
 * and they do it inside their own transaction by passing `tx` in. Reading it is
 * this module's alone.
 */
@Module({
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
