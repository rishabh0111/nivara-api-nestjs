import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../common/errors/app-exception';
import { UserRole } from '../generated/prisma/client';
import { TenancyService } from '../tenancy/tenancy.service';
import { AccessTokenService } from './access-token.service';
import { PasswordService } from './password.service';
import { RefreshTokenService } from './refresh-token.service';
import {
  StaffPrincipal,
  systemContextFor,
  tenantContextFor,
} from './request-principal';
import { rotateRefreshSession } from './session-rotation';

/**
 * What a staff sign-in or refresh produces.
 *
 * `principal` is a `StaffPrincipal` rather than the full union, because this
 * service resolves the `user` table and can produce nothing else. It was the
 * union while there was only one arm and the distinction cost nothing; with
 * three arms it costs the ability to state what this service actually returns —
 * and it would let a widget session, which this service cannot mint a token
 * for, typecheck its way into `issueSession`.
 */
export interface Session {
  principal: StaffPrincipal;
  accessToken: string;
  refreshToken: string;
}

/**
 * The one error every authentication failure becomes.
 *
 * Wrong password, unknown email, an email that exists in another tenant, an
 * invited User with no password set — all of them answer this. Each
 * distinction the response could draw is a fact about who belongs to which
 * tenant, offered to whoever asked without a credential.
 */
const refuse = (): AppException =>
  new AppException('unauthenticated', 'Invalid credentials.');

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly tenancy: TenancyService,
    private readonly passwords: PasswordService,
    private readonly accessTokens: AccessTokenService,
    private readonly refreshTokens: RefreshTokenService,
  ) {}

  /**
   * Signs a User in against `(tenantId, email)`.
   *
   * The tenant arrives from the request, which is the one place in the
   * application where that is not a contradiction: there is no credential yet
   * to read it from. It is a routing input, not an authority claim — naming a
   * tenant only decides which tenant's `user` rows the lookup can see, and
   * seeing them still requires a password. From the moment a token is issued,
   * the tenant comes from the token and never from a request again.
   *
   * The same email at two tenants is two Users with two passwords, and this
   * resolves exactly one of them: the unique index is `(tenantId, email)`, and
   * row-level security means the query could not reach the other tenant's row
   * even if the index allowed it.
   */
  async signIn(input: {
    tenantId: string;
    email: string;
    password: string;
  }): Promise<Session> {
    const now = new Date();

    const session = await this.tenancy.withTenant(
      systemContextFor(input.tenantId),
      async (tx) => {
        const user = await tx.user.findFirst({
          where: { email: input.email.toLowerCase() },
        });

        // Runs even when there is no user, against a null hash, so that an
        // unknown email costs the same as a known one. See `PasswordService`.
        const valid = await this.passwords.verify(
          user?.passwordHash ?? null,
          input.password,
        );

        if (!user || !valid) return null;

        const principal: StaffPrincipal = {
          kind: 'user',
          tenantId: input.tenantId,
          userId: user.id,
          role: user.role,
        };

        const refresh = await this.refreshTokens.issue(tx, {
          tenantId: input.tenantId,
          subject: { kind: 'user', userId: user.id },
          now,
        });

        return { principal, refreshToken: refresh.token };
      },
    );

    return this.issueSession(session);
  }

  /**
   * Exchanges a refresh token for a new pair, rotating it in the process.
   *
   * The read and the rotation share one transaction because the gap between
   * them is the race: two requests that both read a live row would both rotate
   * it, and the second would be indistinguishable from theft. `rotate()`
   * closes it with a conditional update, and `rotateRefreshSession` keeps that
   * update in the same transaction as the verdict that authorized it.
   *
   * The sequence itself lives in `session-rotation.ts` because the portal
   * performs exactly the same one. What is staff-specific is the two lines
   * below: this axis re-reads a `user`, and builds a principal carrying a role.
   */
  async refresh(input: { tenantId: string; token: string }): Promise<Session> {
    const now = new Date();

    const session = await this.tenancy.withTenant(
      systemContextFor(input.tenantId),
      (tx) =>
        rotateRefreshSession<StaffPrincipal>({
          refreshTokens: this.refreshTokens,
          tx,
          token: input.token,
          now,
          expect: 'user',
          logger: this.logger,
          label: 'Refresh',
          tenantId: input.tenantId,
          // Re-read rather than trusting the token's claim of a role: the
          // fifteen minutes an access token is good for is the window a stale
          // role may survive, and minting a fresh one from a stale copy would
          // extend that window indefinitely across a long-lived session.
          resolve: async (client, userId) => {
            const user = await client.user.findFirst({ where: { id: userId } });

            if (!user) return null;

            return {
              kind: 'user',
              tenantId: input.tenantId,
              userId: user.id,
              role: user.role,
            };
          },
        }),
    );

    return this.issueSession(session);
  }

  /**
   * Ends a session by evicting its whole family.
   *
   * Idempotent and silent: signing out with a token the server does not
   * recognize is not an error a client can act on, and reporting it would let
   * an unauthenticated caller probe which tokens exist.
   */
  async signOut(input: { tenantId: string; token: string }): Promise<void> {
    const now = new Date();

    await this.tenancy.withTenant(
      systemContextFor(input.tenantId),
      async (tx) => {
        const found = await this.refreshTokens.classify(tx, input.token, now);

        if ('outcome' in found) return;

        await this.refreshTokens.revokeFamily(tx, found.familyId, now);
      },
    );
  }

  /**
   * The User behind a principal, read inside that principal's own tenant.
   *
   * Lives here rather than in the controller so that every database read in
   * the authentication path goes through one place — and so the read is done
   * under `tenantContextFor()`, which is what makes it evidence that the
   * token's tenant claim reaches row-level security rather than just an echo
   * of the token back to its bearer.
   *
   * Narrowed to `StaffPrincipal` rather than branching on kind. A Contact
   * describing itself is the portal's `GET /portal/auth/me`, over the Contact
   * row, and the type is what keeps the two from becoming one method with a
   * union return that every caller then has to unpick.
   */
  async currentUser(
    principal: StaffPrincipal,
  ): Promise<{ id: string; email: string; name: string; role: UserRole }> {
    const user = await this.tenancy.withTenant(
      tenantContextFor(principal),
      (tx) => tx.user.findFirst({ where: { id: principal.userId } }),
    );

    // A token outliving its User — deleted inside the fifteen minutes the
    // access token stays valid for.
    if (!user) throw AppException.notFound('user');

    return user;
  }

  /** Mints the access token for a session, or refuses if there is none. */
  private async issueSession(
    session: { principal: StaffPrincipal; refreshToken: string } | null,
  ): Promise<Session> {
    if (!session) throw refuse();

    return {
      ...session,
      accessToken: await this.accessTokens.sign(session.principal),
    };
  }
}
