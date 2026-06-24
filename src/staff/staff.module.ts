import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { InvitationService } from './invitation.service';
import { InvitationsController } from './invitations.controller';

/**
 * Staff provisioning — the only door into a tenant.
 *
 * Imports `AuthModule` for `PasswordService` rather than providing its own:
 * accepting an invitation writes a hash that signing in has to verify, and two
 * instances configured differently would be a login failure nobody could
 * reproduce from either file alone.
 */
@Module({
  imports: [AuthModule],
  controllers: [InvitationsController],
  providers: [InvitationService],
})
export class StaffModule {}
