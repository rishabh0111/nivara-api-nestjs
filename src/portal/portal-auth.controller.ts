import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCookieAuth,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Request, Response } from 'express';
import { ACCESS_TOKEN_TTL_SECONDS } from '../auth/access-token.service';
import { Public } from '../auth/auth.guard';
import { SessionDto } from '../auth/dto/session.dto';
import { Principal } from '../auth/principal.decorator';
import {
  PORTAL_REFRESH_COOKIE,
  clearRefreshCookie,
  decodeRefreshCookie,
  encodeRefreshCookie,
  readRefreshCookie,
  setRefreshCookie,
} from '../auth/refresh-cookie';
import { ContactPrincipal } from '../auth/request-principal';
import { RequiresPrincipalKind } from '../authz/require-permission.decorator';
import { ApiErrorResponses } from '../common/errors/api-error-responses.decorator';
import { AppException } from '../common/errors/app-exception';
import { AppConfigService } from '../config/app-config.service';
import { ContactPrincipalDto } from './dto/contact-principal.dto';
import { PortalSignInDto } from './dto/portal-sign-in.dto';
import { PortalAuthService, PortalSession } from './portal-auth.service';

/**
 * The portal's front door.
 *
 * Mounted under `/portal` rather than alongside the staff routes, so which axis
 * a request is on is visible in the path before any code runs. The two sign-ins
 * share a cookie name and a token format but never a route: a Contact posting
 * to `/auth/sign-in` is refused as an unknown User, which is the correct answer
 * — the address it presented is not one of that tenant's staff.
 */
@ApiTags('portal')
@Controller('portal/auth')
export class PortalAuthController {
  constructor(
    private readonly auth: PortalAuthService,
    private readonly config: AppConfigService,
  ) {}

  @Post('sign-in')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign a Contact into the portal',
    description:
      'Returns a 15-minute access token in the body and sets an httpOnly refresh cookie, exactly as staff sign-in does. Every failure answers the same `unauthenticated` error — a wrong password, an unknown address, an address at another tenant, and a Contact with no portal credential at all are deliberately indistinguishable. The last of those is the common case: a Contact created from a widget visit has no password and cannot sign in here.',
  })
  @ApiOkResponse({ type: SessionDto })
  @ApiErrorResponses('validation_failed', 'unauthenticated')
  async signIn(
    @Body() body: PortalSignInDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionDto> {
    return this.respondWith(await this.auth.signIn(body), response);
  }

  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth(PORTAL_REFRESH_COOKIE.name)
  @ApiOperation({
    summary: 'Exchange the portal refresh cookie for a new access token',
    description:
      'Rotates on every use, with the same family-wide replay eviction staff sessions have. A staff refresh token presented here is refused without revoking its family: it is a client error rather than evidence of theft, and evicting the family would sign an agent out of the console for it.',
  })
  @ApiOkResponse({ type: SessionDto })
  @ApiErrorResponses('unauthenticated')
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionDto> {
    const cookie = decodeRefreshCookie(
      readRefreshCookie(request, PORTAL_REFRESH_COOKIE),
    );

    if (!cookie) {
      clearRefreshCookie(
        response,
        PORTAL_REFRESH_COOKIE,
        this.config.isProduction,
      );
      throw new AppException('unauthenticated', 'No refresh token presented.');
    }

    try {
      return this.respondWith(await this.auth.refresh(cookie), response);
    } catch (error) {
      // A token the server will not accept again should stop being sent; left
      // in place, every retry after an eviction reads as fresh theft.
      clearRefreshCookie(
        response,
        PORTAL_REFRESH_COOKIE,
        this.config.isProduction,
      );
      throw error;
    }
  }

  @Post('sign-out')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiCookieAuth(PORTAL_REFRESH_COOKIE.name)
  @ApiOperation({
    summary: 'End the portal session',
    description:
      'Revokes the whole token family and clears the cookie. Idempotent: signing out without a valid cookie succeeds, because whether a given token exists is not something an unauthenticated caller should be able to learn.',
  })
  @ApiNoContentResponse()
  async signOut(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const cookie = decodeRefreshCookie(
      readRefreshCookie(request, PORTAL_REFRESH_COOKIE),
    );

    if (cookie) await this.auth.signOut(cookie);

    clearRefreshCookie(
      response,
      PORTAL_REFRESH_COOKIE,
      this.config.isProduction,
    );
  }

  /**
   * The signed-in Contact, read back through the tenant context its own token
   * armed — the portal's counterpart to `GET /auth/me`, and a database read
   * rather than an echo for the same reason.
   */
  @Get('me')
  @RequiresPrincipalKind('contact')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'The signed-in Contact',
    description:
      'Resolved from the presented credential alone. Reads the Contact row inside the tenant context the token arms, so a response here is evidence the whole chain is wired. A staff token is refused: this describes a Contact, and a User is not one.',
  })
  @ApiOkResponse({ type: ContactPrincipalDto })
  @ApiErrorResponses('unauthenticated', 'forbidden', 'not_found')
  async me(
    @Principal() principal: ContactPrincipal,
  ): Promise<ContactPrincipalDto> {
    const contact = await this.auth.currentContact(principal);

    return {
      kind: 'contact',
      contactId: contact.id,
      tenantId: principal.tenantId,
      email: contact.email,
      name: contact.name,
      verified: contact.verified,
    };
  }

  private respondWith(session: PortalSession, response: Response): SessionDto {
    setRefreshCookie(
      response,
      PORTAL_REFRESH_COOKIE,
      encodeRefreshCookie(session.principal.tenantId, session.refreshToken),
      this.config.isProduction,
    );

    return {
      accessToken: session.accessToken,
      expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
    };
  }
}
