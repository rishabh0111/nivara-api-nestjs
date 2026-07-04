import { ApiProperty } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsString, Length } from 'class-validator';
import { ASSIGNABLE_SCOPES } from '../../authz/service-scopes';

/**
 * What an admin decides when giving software authority inside their tenant.
 *
 * Conspicuously not here, and for the same reason `InviteStaffDto` omits it:
 * the tenant. It comes from the minting admin's credential and nowhere else, so
 * a token cannot be minted into a tenant the admin does not belong to — the
 * request has no field in which to try. The creating User is absent on the same
 * grounds: provenance the requester could type is not provenance.
 */
export class MintServiceTokenDto {
  @ApiProperty({
    example: 'Triage assistant (production)',
    maxLength: 200,
    description:
      'What this credential is for, in your own words. The only reason to list tokens is to decide which one to revoke, and a page of uuids cannot answer that.',
  })
  @IsString()
  @Length(1, 200)
  name!: string;

  /**
   * Validated as strings here and against the catalog in the service, rather
   * than with `@IsIn(ASSIGNABLE_SCOPES)`. The decorator would answer "invalid
   * value" for a typo and for `audit:read` alike, and those are different
   * mistakes with different fixes — one is corrected, the other is a request to
   * reconsider the integration. `classifyScopes` tells them apart and says so.
   */
  @ApiProperty({
    type: [String],
    enum: ASSIGNABLE_SCOPES,
    example: ['ticket:read', 'ticket:reply'],
    description:
      'Permissions this token may exercise, drawn from the same catalog staff roles are built from — there is one authority vocabulary, not two. `GET /service-tokens/scopes` lists what may be granted. Destructive, configuration, user-management and audit-read permissions are refused here: no machine credential can hold them.\n\nReply and note authority are separable, so an AI layer can run suggest-only — `note:write` without `ticket:reply` drafts internally without ever speaking to a customer.',
  })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  scopes!: string[];
}
