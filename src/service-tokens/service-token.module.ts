import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { ServiceTokenService } from './service-token.service';

/**
 * The credential half of service tokens, on its own so the guard can reach it.
 *
 * The same split `WidgetSessionModule` makes, along the line that file predicted
 * this ticket would follow: what *verifies a credential* is a leaf, and what
 * *serves a surface* is not. `AuthGuard` needs to turn a bearer value into a
 * principal and needs nothing else from this feature, so it imports this rather
 * than the controller's module — which would drag a dependency into `AuthModule`
 * for no reason and stand ready to close a cycle later.
 *
 * `AuditModule` is imported rather than the surface owning it, because minting
 * and revoking both write their audit row inside the same transaction as the
 * change, and that transaction is opened here.
 */
@Module({
  imports: [AuditModule],
  providers: [ServiceTokenService],
  exports: [ServiceTokenService],
})
export class ServiceTokenModule {}
