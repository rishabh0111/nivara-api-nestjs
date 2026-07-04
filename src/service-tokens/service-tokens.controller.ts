import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Principal } from '../auth/principal.decorator';
import { StaffPrincipal } from '../auth/request-principal';
import { PERMISSION_CATALOG } from '../authz/permissions';
import { RequiresPermission } from '../authz/require-permission.decorator';
import { ASSIGNABLE_SCOPES } from '../authz/service-scopes';
import { ApiErrorResponses } from '../common/errors/api-error-responses.decorator';
import { UuidParam } from '../common/validation/uuid-param.pipe';
import { AssignableScopesDto } from './dto/assignable-scopes.dto';
import { MintServiceTokenDto } from './dto/mint-service-token.dto';
import {
  MintedServiceTokenDto,
  ServiceTokenDto,
  toServiceTokenDto,
} from './dto/service-token.dto';
import { ServiceTokenService } from './service-token.service';

/**
 * The admin surface for machine credentials.
 *
 * Every route requires `token:manage`, which is un-grantable to a service token
 * — so this controller is reachable by admins and by nothing else, and in
 * particular not by the credentials it manages. A token that could mint its
 * successor would make revocation meaningless, and that containment is enforced
 * by the scope list rather than by a check written here.
 */
@ApiTags('service-tokens')
@Controller('service-tokens')
export class ServiceTokensController {
  constructor(private readonly tokens: ServiceTokenService) {}

  @Post()
  @RequiresPermission('token:manage')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Mint a service token',
    description:
      'Admin-only. Returns the credential **once** — only a hash is stored, so it cannot be recovered afterwards and a lost token is reminted rather than looked up.\n\nThe tenant and the minting User are stamped from your credential, never taken from the request. Scopes are drawn from the same permission catalog staff roles are built from; destructive, configuration, user-management and audit-read permissions are refused.',
  })
  @ApiCreatedResponse({ type: MintedServiceTokenDto })
  @ApiErrorResponses('validation_failed', 'unauthenticated', 'forbidden')
  async mint(
    // Staff by construction: `token:manage` is a grant only a role confers, so
    // the guard has already refused every other kind of principal.
    @Principal() principal: StaffPrincipal,
    @Body() body: MintServiceTokenDto,
  ): Promise<MintedServiceTokenDto> {
    const { token, raw } = await this.tokens.mint(principal, body);

    return { ...toServiceTokenDto(token), token: raw };
  }

  /**
   * Declared before the `:id` routes would matter, and worth stating anyway:
   * `scopes` is a literal segment, so it could never be mistaken for the uuid
   * `DELETE /service-tokens/:id` expects — different verb, different shape.
   */
  @Get('scopes')
  @RequiresPermission('token:manage')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'List the scopes a service token may be granted',
    description:
      'Published so tooling does not hardcode the list. These are permissions from the staff catalog — the same vocabulary, not a parallel one — minus everything no machine credential may hold.',
  })
  @ApiOkResponse({ type: AssignableScopesDto })
  @ApiErrorResponses('unauthenticated', 'forbidden')
  assignableScopes(): AssignableScopesDto {
    return {
      // Descriptions read from the catalog rather than restated here, so the
      // list and the words explaining it cannot drift apart.
      scopes: ASSIGNABLE_SCOPES.map((scope) => ({
        scope,
        description: PERMISSION_CATALOG[scope],
      })),
    };
  }

  @Get()
  @RequiresPermission('token:manage')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'List this tenant’s service tokens',
    description:
      'Newest first, and including revoked tokens: the operator question is what has ever held authority here, and a token that vanished on revocation would make an incident harder to reconstruct. The credential itself is never returned — it exists nowhere the server could read it.',
  })
  @ApiOkResponse({ type: [ServiceTokenDto] })
  @ApiErrorResponses('unauthenticated', 'forbidden')
  async list(
    @Principal() principal: StaffPrincipal,
  ): Promise<ServiceTokenDto[]> {
    const tokens = await this.tokens.list(principal);

    return tokens.map(toServiceTokenDto);
  }

  @Delete(':id')
  @RequiresPermission('token:manage')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Revoke a service token',
    description:
      'Takes effect on the token’s very next request — the authentication path reads the row every time and caches nothing, because a TTL here would be revocation delay.\n\nFinal: a revoked token cannot be reinstated, and restoring access means minting a new one. The row is kept rather than deleted so the audit trail still has something to point at.',
  })
  @ApiNoContentResponse()
  @ApiErrorResponses(
    'malformed_request',
    'unauthenticated',
    'forbidden',
    'not_found',
    'conflict',
  )
  async revoke(
    @Principal() principal: StaffPrincipal,
    @Param('id', UuidParam) id: string,
  ): Promise<void> {
    await this.tokens.revoke(principal, id);
  }
}
