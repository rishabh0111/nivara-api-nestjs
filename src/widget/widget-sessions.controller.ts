import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Public } from '../auth/auth.guard';
import { Principal } from '../auth/principal.decorator';
import { WidgetPrincipal } from '../auth/request-principal';
import { RequiresPrincipalKind } from '../authz/require-permission.decorator';
import { ApiErrorResponses } from '../common/errors/api-error-responses.decorator';
import { StartWidgetSessionDto } from './dto/start-session.dto';
import { WidgetSessionDto } from './dto/widget-session.dto';
import { WidgetSessionService } from './widget-session.service';

/**
 * The widget's front door: getting a session, and keeping it.
 *
 * Two endpoints on opposite sides of the trust boundary, which is why they are
 * decorated so differently. Minting is `@Public()` — a visitor has no
 * credential and the whole point is that asking a question needs no account —
 * so the `Origin` allowlist is the only gate, and it carries the weight
 * accordingly. Renewal is authenticated: by then the caller holds a session,
 * and the guard has already verified and un-revoked it before this class runs.
 */
@ApiTags('widget')
@Controller('widget/sessions')
export class WidgetSessionsController {
  constructor(private readonly sessions: WidgetSessionService) {}

  @Post()
  @Public()
  @ApiOperation({
    summary: 'Start an anonymous widget session',
    description:
      'Mints a 30-minute session for a visitor on the tenant’s own site. No account, no credential, and nothing durable stored about the visitor — the session’s Contact is created only when they do something that needs a requester, such as opening a Ticket.\n\nGated by the tenant’s `Origin` allowlist and by nothing else. A tenant that has not configured any origin has the widget switched off, and is refused identically to an unknown tenant and to a disallowed page: the refusal cannot be used to learn whether a given tenant id is real.',
  })
  @ApiCreatedResponse({ type: WidgetSessionDto })
  @ApiErrorResponses('validation_failed', 'forbidden')
  async start(
    @Body() body: StartWidgetSessionDto,
    // Read from the header rather than the body for the obvious reason: a value
    // the caller could type is not evidence of where they are. The browser sets
    // this one and a page cannot override it.
    @Headers('origin') origin: string | undefined,
  ): Promise<WidgetSessionDto> {
    return this.sessions.bootstrap({ tenantId: body.tenantId, origin });
  }

  @Post('renew')
  @RequiresPrincipalKind('widget')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'Extend this widget session',
    description:
      'Returns a fresh token for the **same** session, so the visitor’s Contact and their Tickets survive the renewal — a conversation that runs past thirty minutes is still one conversation. Call it before `expiresInSeconds` elapses; there is no grace period after expiry, and a lapsed session must start a new one.\n\nThe `Origin` allowlist is checked again here, so a token lifted onto another page cannot keep itself alive from there. A revoked session is refused.',
  })
  @ApiOkResponse({ type: WidgetSessionDto })
  @ApiErrorResponses('unauthenticated', 'forbidden')
  async renew(
    @Principal() principal: WidgetPrincipal,
    @Headers('origin') origin: string | undefined,
  ): Promise<WidgetSessionDto> {
    return this.sessions.renew(principal, origin);
  }
}
