import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AppConfigService } from '../config/app-config.service';
import { UserRole } from '../generated/prisma/client';
import {
  ContactPrincipal,
  RequestPrincipal,
  StaffPrincipal,
} from './request-principal';

/** Fifteen minutes. Short enough that revocation can be left to expiry. */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

export const ACCESS_TOKEN_ISSUER = 'nivara-desk';
export const ACCESS_TOKEN_AUDIENCE = 'nivara-api';

/**
 * The claims an access token carries, and nothing more.
 *
 * `tenantId` is the load-bearing one: it is the sole authority for which
 * tenant a request acts in, and what `withTenant()` is armed from.
 *
 * `kind` is the second, and it arrived with the portal. One secret signs both
 * staff and Contact tokens, so a signature no longer says *what* the bearer is
 * — only that this server minted it. This claim is what says, and it is written
 * explicitly rather than left to be inferred from whether `role` is present:
 * identity by shape is identity by accident.
 *
 * `role` is carried on the staff arm rather than looked up so the common path
 * costs no query — the fifteen-minute lifetime is what bounds how stale it can
 * be. There is no contact equivalent, because a Contact has no role to go stale.
 */
export type AccessTokenClaims = StaffTokenClaims | ContactTokenClaims;

export interface StaffTokenClaims {
  kind: 'user';
  sub: string;
  tenantId: string;
  role: UserRole;
}

export interface ContactTokenClaims {
  kind: 'contact';
  sub: string;
  tenantId: string;
}

/**
 * Mints and verifies the short-lived half of a session.
 *
 * HS256 and one shared secret, because one process both signs and verifies.
 * The asymmetric seam is left open deliberately: moving to RS256 so a
 * downstream service can verify independently changes this file and nothing
 * that depends on it, since callers only ever see a `RequestPrincipal`.
 */
@Injectable()
export class AccessTokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Mints an access token for the two principals this service is the issuer of.
   *
   * Narrowed to those two rather than taking a `RequestPrincipal`, because a
   * widget session is not an access token: it is signed by a different key, has
   * a different lifetime, and is backed by a row that can revoke it. Handing one
   * to this method would mint a *staff-key* credential for an anonymous visitor
   * — the exact confusion the second key exists to prevent — so the type refuses
   * it at the call site rather than a runtime branch refusing it later.
   */
  async sign(principal: StaffPrincipal | ContactPrincipal): Promise<string> {
    const claims: AccessTokenClaims =
      principal.kind === 'user'
        ? {
            kind: 'user',
            sub: principal.userId,
            tenantId: principal.tenantId,
            role: principal.role,
          }
        : {
            kind: 'contact',
            sub: principal.contactId,
            tenantId: principal.tenantId,
          };

    return this.jwt.signAsync(claims, {
      secret: this.config.jwtSecret,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      issuer: ACCESS_TOKEN_ISSUER,
      audience: ACCESS_TOKEN_AUDIENCE,
    });
  }

  /**
   * Verifies a token and reduces it to a principal, or returns `null`.
   *
   * `null` rather than a thrown error for every rejection alike: an expired
   * token, one signed with a foreign key, one with a claim missing, and one
   * that is not a JWT at all are the same fact to a caller — no valid
   * credential — and telling them apart in the response would describe the
   * server's key material to whoever is probing it.
   *
   * The claim shape is checked rather than assumed. A validly-signed token is
   * only proof that this server issued it, not that it issued it with the
   * claims this version of the code expects, and `tenantId` is too load-bearing
   * to take on trust: an absent one would arm no tenant, or worse, `undefined`.
   */
  async verify(token: string): Promise<RequestPrincipal | null> {
    let claims: unknown;

    try {
      claims = await this.jwt.verifyAsync<object>(token, {
        secret: this.config.jwtSecret,
        issuer: ACCESS_TOKEN_ISSUER,
        audience: ACCESS_TOKEN_AUDIENCE,
        algorithms: ['HS256'],
      });
    } catch {
      return null;
    }

    return principalFromClaims(claims);
  }
}

const ROLES: string[] = Object.values(UserRole);

const isRole = (value: unknown): value is UserRole =>
  typeof value === 'string' && ROLES.includes(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value !== '';

/**
 * Exported for the unit tests, which exercise the claim shape without a key.
 *
 * The `kind` switch is the security boundary between the two surfaces, and the
 * two branches are deliberately disjoint rather than one branch with optional
 * extras. `role` is read only on the staff arm, so a Contact's token carrying a
 * role claim — which nothing in this server would mint, and which is exactly
 * what a forgery attempt looks like — resolves to a Contact with no authority
 * rather than to a question about precedence.
 *
 * An unrecognized or absent `kind` is refused rather than defaulted. Defaulting
 * to `user` would promote every claim-less token to staff; defaulting to
 * `contact` would still let a token's shape decide who its bearer is.
 *
 * `widget` is refused here and always will be, which is a different case from
 * the two below it: widget sessions are a real principal kind, but they are
 * signed by a different key and verified by `WidgetSessionService`, so a token
 * claiming `widget` on *this* key is one this server did not issue. `service`
 * is refused for the ordinary reason and becomes a third arm once service
 * tokens land.
 */
export const principalFromClaims = (
  claims: unknown,
): RequestPrincipal | null => {
  if (typeof claims !== 'object' || claims === null) return null;

  const { kind, sub, tenantId, role } = claims as Record<string, unknown>;

  // Common to both arms: without a subject there is nobody to be, and without a
  // tenant there is no context to arm.
  if (!isNonEmptyString(sub)) return null;
  if (!isNonEmptyString(tenantId)) return null;

  if (kind === 'user') {
    if (!isRole(role)) return null;

    return { kind: 'user', tenantId, userId: sub, role };
  }

  if (kind === 'contact') {
    return { kind: 'contact', tenantId, contactId: sub };
  }

  return null;
};
