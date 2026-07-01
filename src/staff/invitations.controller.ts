import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../auth/auth.guard';
import { Principal } from '../auth/principal.decorator';
import { StaffPrincipal } from '../auth/request-principal';
import { RequiresPermission } from '../authz/require-permission.decorator';
import { ApiErrorResponses } from '../common/errors/api-error-responses.decorator';
import { AcceptInvitationDto } from './dto/accept-invitation.dto';
import { InvitationDto } from './dto/invitation.dto';
import { InviteStaffDto } from './dto/invite-staff.dto';
import { InvitationService } from './invitation.service';

@ApiTags('staff')
@Controller('staff/invitations')
export class InvitationsController {
  constructor(private readonly invitations: InvitationService) {}

  @Post()
  @RequiresPermission('user:invite')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Invite a staff member into the tenant',
    description:
      'Admin-only. Creates a pending User with the given role and returns a single-use invitation token, shown exactly once. The tenant is taken from the calling admin’s credential — there is no self-service way into a tenant.',
  })
  @ApiCreatedResponse({ type: InvitationDto })
  @ApiErrorResponses(
    'validation_failed',
    'unauthenticated',
    'forbidden',
    'conflict',
  )
  async invite(
    // Staff by construction: `user:invite` is a grant only a role confers, so
    // the guard has already refused every other kind of principal by the time
    // this runs.
    @Principal() principal: StaffPrincipal,
    @Body() body: InviteStaffDto,
  ): Promise<InvitationDto> {
    const invitation = await this.invitations.invite(principal, body);

    return {
      id: invitation.id,
      userId: invitation.userId,
      email: invitation.email,
      role: invitation.role,
      token: invitation.token,
      expiresAt: invitation.expiresAt.toISOString(),
    };
  }

  /**
   * The other end of provisioning, and necessarily public: the person
   * accepting has no credential until this succeeds. The invitation token *is*
   * the credential for this one call.
   */
  @Post('accept')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Accept an invitation by setting a password',
    description:
      'Spends the invitation and sets the invited User’s password; they can then sign in. Single-use — an already-accepted, expired, or unknown token is refused identically, because which of the three it is describes the state of someone’s account to whoever holds the link.',
  })
  @ApiNoContentResponse()
  @ApiErrorResponses('validation_failed', 'unauthenticated')
  async accept(@Body() body: AcceptInvitationDto): Promise<void> {
    await this.invitations.accept(body);
  }
}
