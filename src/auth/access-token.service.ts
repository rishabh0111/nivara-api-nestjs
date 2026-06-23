import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AppConfigService } from '../config/app-config.service';
import { UserRole } from '../generated/prisma/client';
import { RequestPrincipal } from './request-principal';

/** Fifteen minutes. Short enough that revocation can be left to expiry. */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

export const ACCESS_TOKEN_ISSUER = 'nivara-desk';
export const ACCESS_TOKEN_AUDIENCE = 'nivara-api';

/**
 * The claims a staff access token carries, and nothing more.
 *
 * `tenantId` is the load-bearing one: it is the sole authority for which
 * tenant a request acts in, and what `withTenant()` is armed from. `role` is
 * carried rather than looked up so the common path costs no query — the
 * fifteen-minute lifetime is what bounds how stale it can be.
 */
export interface AccessTokenClaims {
  sub: string;
  tenantId: string;
  role: UserRole;
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

  async sign(principal: RequestPrincipal): Promise<string> {
    const claims: AccessTokenClaims = {
      sub: principal.userId,
      tenantId: principal.tenantId,
      role: principal.role,
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

/** Exported for the unit tests, which exercise the claim shape without a key. */
export const principalFromClaims = (
  claims: unknown,
): RequestPrincipal | null => {
  if (typeof claims !== 'object' || claims === null) return null;

  const { sub, tenantId, role } = claims as Record<string, unknown>;

  if (typeof sub !== 'string' || sub === '') return null;
  if (typeof tenantId !== 'string' || tenantId === '') return null;
  if (!isRole(role)) return null;

  return { kind: 'user', tenantId, userId: sub, role };
};
