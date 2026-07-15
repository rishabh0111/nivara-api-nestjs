import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, IsUrl, MaxLength } from 'class-validator';

/**
 * The second way into a staff session, and the same shape of promise as the
 * first: naming a tenant decides which tenant's `user` rows the lookup can see,
 * and seeing one still requires Google to vouch for the address.
 *
 * The browser redirect itself belongs to the web client, not to this API. The
 * client sends the person to Google, owns the `state` value that protects its own
 * redirect from cross-site forgery, and receives the code at its own URL — then
 * hands the code here. That split is why this is one POST rather than a
 * start-and-callback pair: the only step that needs the client *secret* is the
 * exchange, which is the only step that happens on a server.
 */
export class GoogleSignInDto {
  @ApiProperty({
    description:
      'Which tenant to sign in to. The Google identity binds against `(tenantId, email)`, so the same Google account at two tenants reaches two separate Users.',
    format: 'uuid',
  })
  @IsUUID()
  tenantId!: string;

  @ApiProperty({
    description:
      'The one-time authorization code Google redirected back to the client with.',
    maxLength: 2048,
  })
  @IsString()
  // A ceiling and no floor, for the reason `SignInDto.password` has neither: a
  // short code must be refused for being wrong, not for being short, and 422
  // before the exchange would answer a probe differently from a spent code.
  @MaxLength(2048)
  code!: string;

  @ApiProperty({
    description:
      'The redirect URI the code was issued against. Google refuses any value not registered for this client, so this selects among the registered URIs rather than naming a new one.',
    example: 'https://app.nivara.example/auth/google/callback',
  })
  @IsUrl({ require_tld: false })
  @MaxLength(2048)
  redirectUri!: string;
}
