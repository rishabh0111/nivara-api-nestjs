import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, MaxLength, MinLength } from 'class-validator';

/**
 * Accepting an invitation, by someone who has no credential yet.
 *
 * The tenant arrives as input for the same reason it does on sign-in: there is
 * no token to read it from. It is a routing input rather than an authority
 * claim — naming a tenant only decides whose invitations the lookup can see,
 * and being seen still requires the secret.
 */
export class AcceptInvitationDto {
  @ApiProperty({
    format: 'uuid',
    description: 'The tenant the invitation was issued in.',
  })
  @IsUUID()
  tenantId!: string;

  @ApiProperty({
    description:
      'The single-use secret from the invitation, shown to the admin exactly once at issue.',
  })
  @IsString()
  @MaxLength(256)
  token!: string;

  @ApiProperty({
    format: 'password',
    minLength: 12,
    maxLength: 256,
    description: 'The password this staff member will sign in with.',
  })
  @IsString()
  /*
   * A floor here, unlike on sign-in, and the asymmetry is the point: this is
   * where a password is *chosen*, so telling the person their choice is too
   * short is help rather than an oracle. The sign-in DTO deliberately has no
   * minimum, because there a length complaint would tell a guesser their guess
   * was refused for its shape rather than its correctness.
   */
  @MinLength(12)
  @MaxLength(256)
  password!: string;
}
