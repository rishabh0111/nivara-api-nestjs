import { ApiProperty } from '@nestjs/swagger';
import { grantedScopes } from '../../authz/service-scopes';
import { ServiceToken } from '../../generated/prisma/client';

/**
 * A service token as it can safely be described after minting.
 *
 * Note the absent field: there is no `token`. Not omitted for tidiness — the
 * raw value genuinely does not exist anywhere the server could read, and this
 * class is where that fact becomes structural rather than a `select` clause
 * somebody has to remember. `MintedServiceTokenDto` extends this with the one
 * copy, and it is returned by exactly one endpoint.
 */
export class ServiceTokenDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Triage assistant (production)' })
  name!: string;

  @ApiProperty({
    type: [String],
    example: ['ticket:read', 'ticket:reply'],
    description:
      'The permissions this token actually carries — what it would be authorized for on its next request, not the raw stored column. The two differ only for a row written outside the mint path, and in that case this list is the honest one.',
  })
  scopes!: string[];

  @ApiProperty({
    format: 'uuid',
    description:
      'The User who minted it. Stamped by the server from their credential, so it cannot be forged.',
  })
  createdById!: string;

  @ApiProperty({
    format: 'date-time',
    nullable: true,
    description:
      'When it was revoked, or null while it is live. Revocation is final and takes effect on the token’s very next request — there is no cache in the authentication path.',
  })
  revokedAt!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

/**
 * The mint response: the token, plus the only copy of its secret that will ever
 * exist.
 *
 * A separate class from `ServiceTokenDto` rather than a nullable field on it,
 * so "the raw value appears in exactly one response shape" is visible in the
 * OpenAPI document and enforced by the type system rather than by a convention.
 */
export class MintedServiceTokenDto extends ServiceTokenDto {
  @ApiProperty({
    example: 'nvk_live_0195c8e0-1a2b-7c3d-8e4f-5a6b7c8d9e0f.J8s...',
    description:
      'The credential, shown **once**. Only its hash is stored, so it cannot be recovered — a lost token is reminted, never looked up. Store it wherever your integration keeps secrets before leaving this response.',
  })
  token!: string;
}

/**
 * One mapper for both shapes, so the list and the mint response cannot come to
 * disagree about what a token looks like — and so neither can grow a path that
 * serializes `tokenHash` by spreading the row.
 *
 * The scopes go through `grantedScopes()` — the same narrowing `verify()`
 * applies — so that what an admin is shown is what the token can actually do.
 * Reporting the raw column instead would matter in exactly the case the
 * narrowing exists for: a row written outside the mint path would be listed as
 * carrying `audit:read` while conferring nothing, which is the more dangerous
 * direction for a display to be wrong in.
 */
export const toServiceTokenDto = (token: ServiceToken): ServiceTokenDto => ({
  id: token.id,
  name: token.name,
  scopes: grantedScopes(token.scopes),
  createdById: token.createdById,
  revokedAt: token.revokedAt?.toISOString() ?? null,
  createdAt: token.createdAt.toISOString(),
});
