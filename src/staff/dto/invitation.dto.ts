import { ApiProperty } from '@nestjs/swagger';
import { UserRole } from '../../generated/prisma/client';

/**
 * A freshly issued invitation, including the one copy of its secret that will
 * ever exist.
 *
 * Returned to the admin rather than emailed, deliberately: there is no mail
 * transport in this build, and inventing one would put a delivery dependency
 * in the middle of the provisioning path. The admin passes the token to the
 * invitee over whatever channel they already trust.
 */
export class InvitationDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({
    format: 'uuid',
    description: 'The pending User this invitation provisioned.',
  })
  userId!: string;

  @ApiProperty({ format: 'email' })
  email!: string;

  @ApiProperty({ enum: Object.values(UserRole) })
  role!: UserRole;

  @ApiProperty({
    description:
      'The single-use secret, shown **once**. Only its hash is stored, so it cannot be recovered — a lost invitation is reissued, never looked up.',
  })
  token!: string;

  @ApiProperty({
    format: 'date-time',
    description: 'After this, the invitation is refused and must be reissued.',
  })
  expiresAt!: string;
}
