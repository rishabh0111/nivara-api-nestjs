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
import {
  AuthenticatedOnly,
  RequiresPrincipalKind,
} from '../authz/require-permission.decorator';
import { ApiErrorResponses } from '../common/errors/api-error-responses.decorator';
import { AppException } from '../common/errors/app-exception';
import { AppConfigService } from '../config/app-config.service';
import { ACCESS_TOKEN_TTL_SECONDS } from './access-token.service';
import { AuthService, Session, refuseAuthentication } from './auth.service';
import { Public } from './auth.guard';
import { GoogleOidcClient } from './google-client';
import { GoogleSignInDto } from './dto/google-sign-in.dto';
import { PrincipalDto, SessionDto } from './dto/session.dto';
import { SignInDto } from './dto/sign-in.dto';
import { Principal } from './principal.decorator';
import {
  REFRESH_COOKIE,
  STAFF_REFRESH_COOKIE,
  clearRefreshCookie,
  decodeRefreshCookie,
  encodeRefreshCookie,
  readRefreshCookie,
  setRefreshCookie,
} from './refresh-cookie';
import { StaffPrincipal } from './request-principal';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly config: AppConfigService,
    private readonly google: GoogleOidcClient,
  ) {}

  @Post('sign-in')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign in with email and password',
    description:
      'Returns a 15-minute access token in the body and sets an httpOnly refresh cookie. Every failure answers the same `unauthenticated` error: a wrong password, an unknown address, and an address belonging to a different tenant are deliberately indistinguishable.',
  })
  @ApiOkResponse({ type: SessionDto })
  @ApiErrorResponses('validation_failed', 'unauthenticated')
  async signIn(
    @Body() body: SignInDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionDto> {
    const session = await this.auth.signIn(body);

    return this.respondWith(session, response);
  }

  /**
   * The same session, reached with a Google account instead of a password.
   *
   * Answers the identical body and sets the identical cookie as `sign-in`, and
   * shares `respondWith` to guarantee it: a second response shape here would be
   * a second thing every client has to handle, for a difference that exists only
   * in how the person proved who they were.
   */
  @Post('google')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign in with Google',
    description:
      'Exchanges an authorization code for a session. Binds to an existing invite-provisioned User by verified Google email against `(tenantId, email)`; a Google identity with no such User is refused rather than provisioned, because the invite is the only source of membership. Answers `integration_dormant` when this deployment has no Google configuration — check that before offering the affordance.',
  })
  @ApiOkResponse({ type: SessionDto })
  @ApiErrorResponses(
    'validation_failed',
    'unauthenticated',
    'integration_dormant',
  )
  async signInWithGoogle(
    @Body() body: GoogleSignInDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionDto> {
    // The dormancy gate, and it answers before the tenant is even looked at.
    // Distinguishable from a refused credential on purpose: whether *this
    // deployment* configured Google is a deployment fact rather than a fact
    // about anybody's account, and a client needs it to decide whether to show
    // the button at all. Every refusal *after* this point is indistinguishable.
    if (!this.google.isConfigured) {
      throw new AppException(
        'integration_dormant',
        'Google sign-in is not configured in this deployment. Sign in with email and password instead.',
      );
    }

    const identity = await this.google.exchange({
      code: body.code,
      redirectUri: body.redirectUri,
      now: new Date(),
    });

    // Google refused, or answered something that is not an identity. Refused
    // through the same factory `AuthService` uses, so that "Google would not
    // vouch for you" and "nobody here invited you" are one indistinguishable
    // answer rather than two that happen to be spelled alike today.
    if (!identity) throw refuseAuthentication();

    const session = await this.auth.signInWithGoogle({
      tenantId: body.tenantId,
      identity,
    });

    return this.respondWith(session, response);
  }

  /**
   * The silent half of the session.
   *
   * Takes no body at all: the cookie is the entire request. A refresh token in
   * a body would be one a page script had to be able to read.
   */
  @Post('refresh')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiCookieAuth(REFRESH_COOKIE)
  @ApiOperation({
    summary: 'Exchange the refresh cookie for a new access token',
    description:
      'Rotates the refresh token on every use. Presenting an already-rotated token is treated as theft and revokes the entire token family, so both copies stop working and the legitimate client signs in again.',
  })
  @ApiOkResponse({ type: SessionDto })
  @ApiErrorResponses('unauthenticated')
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionDto> {
    const cookie = decodeRefreshCookie(
      readRefreshCookie(request, STAFF_REFRESH_COOKIE),
    );

    if (!cookie) {
      clearRefreshCookie(
        response,
        STAFF_REFRESH_COOKIE,
        this.config.isProduction,
      );
      throw new AppException('unauthenticated', 'No refresh token presented.');
    }

    try {
      const session = await this.auth.refresh(cookie);

      return this.respondWith(session, response);
    } catch (error) {
      // A token the server will not accept again should stop being sent.
      // Left in place, a client retries it forever and every retry after an
      // eviction reads as fresh theft.
      clearRefreshCookie(
        response,
        STAFF_REFRESH_COOKIE,
        this.config.isProduction,
      );
      throw error;
    }
  }

  @Post('sign-out')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiCookieAuth(REFRESH_COOKIE)
  @ApiOperation({
    summary: 'End the session',
    description:
      'Revokes the whole token family and clears the cookie. Idempotent: signing out without a valid cookie succeeds, because whether a given token exists is not something an unauthenticated caller should be able to learn.',
  })
  @ApiNoContentResponse()
  async signOut(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const cookie = decodeRefreshCookie(
      readRefreshCookie(request, STAFF_REFRESH_COOKIE),
    );

    if (cookie) await this.auth.signOut(cookie);

    clearRefreshCookie(
      response,
      STAFF_REFRESH_COOKIE,
      this.config.isProduction,
    );
  }

  /**
   * The authenticated caller, read back through the tenant context their own
   * token armed.
   *
   * Deliberately a database read rather than an echo of the token's claims. An
   * echo would answer identically whether or not tenant arming worked, which
   * makes this the cheapest possible end-to-end proof that the `tenantId`
   * claim reaches row-level security: the User row is only visible from inside
   * the context the token established.
   */
  @Get('me')
  // Describing yourself to yourself is not an authority anyone holds over
  // anyone, so this operation requires no *permission* — said out loud, because
  // the authorization guard refuses anything that stays silent.
  //
  // It does require a kind. This reads a User row, and a Contact asking for one
  // is asking for a row that does not describe it: the honest answer is a
  // refusal rather than a 404 that reads as "your account is missing". The
  // portal's `GET /portal/auth/me` is where a Contact describes itself.
  @AuthenticatedOnly()
  @RequiresPrincipalKind('user')
  @ApiBearerAuth()
  @ApiOperation({
    summary: 'The authenticated staff principal',
    description:
      'Resolved from the presented credential alone. Reads the User row inside the tenant context the token arms, so a response here is evidence the whole chain is wired. A portal token is refused — a Contact describes itself at `GET /portal/auth/me`.',
  })
  @ApiOkResponse({ type: PrincipalDto })
  @ApiErrorResponses('unauthenticated', 'forbidden', 'not_found')
  async me(@Principal() principal: StaffPrincipal): Promise<PrincipalDto> {
    const user = await this.auth.currentUser(principal);

    return {
      kind: principal.kind,
      userId: user.id,
      tenantId: principal.tenantId,
      role: user.role,
      email: user.email,
      name: user.name,
    };
  }

  private respondWith(session: Session, response: Response): SessionDto {
    setRefreshCookie(
      response,
      STAFF_REFRESH_COOKIE,
      encodeRefreshCookie(session.principal.tenantId, session.refreshToken),
      this.config.isProduction,
    );

    return {
      accessToken: session.accessToken,
      expiresInSeconds: ACCESS_TOKEN_TTL_SECONDS,
    };
  }
}
