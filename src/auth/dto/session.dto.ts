import { ApiProperty } from '@nestjs/swagger';
import { UserRole } from '../../generated/prisma/client';
import { ACCESS_TOKEN_TTL_SECONDS } from '../access-token.service';

/**
 * What a sign-in or refresh returns.
 *
 * The refresh token is conspicuously absent: it leaves only in an httpOnly
 * cookie, so no page script can read it. Putting it in the body as well would
 * hand back in JSON exactly what the cookie flag exists to withhold.
 */
export class SessionDto {
  @ApiProperty({
    description:
      'Bearer credential for the API. Hold it in memory — persisting it to `localStorage` puts it back within reach of a page script.',
  })
  accessToken!: string;

  @ApiProperty({
    description:
      'Seconds until the access token expires. Refresh before this elapses; the refresh cookie is sent automatically.',
    example: ACCESS_TOKEN_TTL_SECONDS,
  })
  expiresInSeconds!: number;
}

/** The authenticated caller, as the server resolved them from the credential. */
export class PrincipalDto {
  @ApiProperty({
    enum: ['user'],
    description:
      'Which kind of caller this is. Service tokens introduce a second value; clients should treat this as an open set.',
  })
  kind!: 'user';

  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({ enum: Object.values(UserRole) })
  role!: UserRole;

  @ApiProperty({ format: 'email' })
  email!: string;

  @ApiProperty()
  name!: string;
}
