import { Injectable, Logger } from '@nestjs/common';
import { AppConfigService } from '../config/app-config.service';
import {
  GoogleIdentity,
  readIdTokenFromTokenEndpoint,
} from './google-id-token';

/** Google's OAuth 2.0 token endpoint. Fixed — there is one Google. */
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/**
 * How long the exchange may take before it is abandoned.
 *
 * Bounded because this call sits inside an unauthenticated request: `fetch` has
 * no timeout by default, so a hung connection to Google would hold a request
 * open indefinitely, and an anonymous caller could open as many as they liked.
 */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * The only thing in this system that talks to Google.
 *
 * A class with one method, and it exists as a class for the reason `SlackClient`
 * does: it is the seam a test replaces. Everything above it — the binding to an
 * invite-provisioned User, the session it mints, the refusal when there is no
 * such User — is then exercised against a real database with only the network
 * stubbed, which is the boundary worth drawing.
 *
 * `fetch` rather than `google-auth-library`. The call is one form-encoded POST,
 * and what is left in this file is a description of an HTTP request, which ports
 * to Spring and FastAPI unchanged. The library's value is JWKS verification of
 * client-supplied ID tokens, which this flow deliberately does not do — see
 * `google-id-token.ts`.
 */
@Injectable()
export class GoogleOidcClient {
  private readonly logger = new Logger(GoogleOidcClient.name);

  constructor(private readonly config: AppConfigService) {}

  /**
   * Whether this process can talk to Google at all.
   *
   * Read from the feature gate rather than from a secret being non-undefined at
   * the call site, so "Google is dormant" is one fact with one owner. A dormant
   * integration is the normal state — it is what makes the key-free first run
   * work — not a degraded one.
   */
  get isConfigured(): boolean {
    return this.config.features.google;
  }

  /**
   * Turns an authorization code into the identity Google will vouch for, or
   * `null` if it will not.
   *
   * `redirectUri` is supplied by the caller and passed straight through, which
   * looks like trusting client input and is not. Google validates it against the
   * URIs registered for this client and refuses anything else, so an attacker
   * cannot name their own — and it *must* be echoed here regardless, because the
   * exchange only succeeds when it matches the one the code was issued against.
   *
   * One `null` for every failure. Which check refused — a spent code, a token
   * for another application, an unverified address — is a fact about somebody
   * else's Google account, and none of it is actionable to the caller, who can
   * only start the flow again. The reason goes to the log instead.
   */
  async exchange(input: {
    code: string;
    redirectUri: string;
    now: Date;
  }): Promise<GoogleIdentity | null> {
    const clientId = this.config.googleClientId;
    const clientSecret = this.config.googleClientSecret;

    // Belt and braces against a caller that skipped `isConfigured`. Answering
    // `null` rather than throwing keeps a dormant deployment's behaviour a
    // refusal rather than a 500 — but the controller is what makes that answer
    // an honest one, and this is only here so the failure cannot be a crash.
    if (!clientId || !clientSecret) {
      this.logger.warn(
        'A Google exchange was attempted while Google is dormant.',
      );

      return null;
    }

    let response: Response;

    try {
      response = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: input.code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: input.redirectUri,
        }),
      });
    } catch (error) {
      // Google being unreachable is not the same as a bad code, and it is worth
      // saying so in the log — but not in the response, where the distinction
      // would tell a caller probing this endpoint which of their inputs was
      // wrong. The caller retries either way.
      this.logger.warn(
        `The Google token exchange failed to complete: ${String(error)}`,
      );

      return null;
    }

    if (!response.ok) {
      this.logger.warn(
        `Google answered HTTP ${response.status} to the token exchange.`,
      );

      return null;
    }

    const body = (await response.json().catch(() => null)) as {
      id_token?: unknown;
    } | null;

    // No ID token means this was an OAuth grant without the `openid` scope: the
    // caller asked Google for API access rather than for an identity, and there
    // is nothing here to authenticate anybody with.
    if (typeof body?.id_token !== 'string') {
      this.logger.warn(
        'Google returned no id_token, so there is no identity to bind.',
      );

      return null;
    }

    const result = readIdTokenFromTokenEndpoint({
      idToken: body.id_token,
      clientId,
      now: input.now,
    });

    if (result.outcome === 'refuse') {
      this.logger.warn(`Google’s id_token was refused: ${result.reason}`);

      return null;
    }

    return result.identity;
  }
}
