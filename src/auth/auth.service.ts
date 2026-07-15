import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../common/errors/app-exception';
import { UserRole } from '../generated/prisma/client';
import { classifyInvitation } from '../staff/invitation-lifecycle';
import { TenancyService } from '../tenancy/tenancy.service';
import { AccessTokenService } from './access-token.service';
import { GoogleIdentity } from './google-id-token';
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
 * invited User with no password set, a Google account nobody invited, a spent
 * authorization code — all of them answer this. Each distinction the response
 * could draw is a fact about who belongs to which tenant, offered to whoever
 * asked without a credential.
 *
 * Exported because the Google path refuses one step earlier than this service —
 * at the exchange, before there is a tenant to look a User up in — and a second
 * refusal spelled out there would be a side channel separating "Google would not
 * vouch for you" from "nobody invited you", which is precisely the pair that
 * must stay indistinguishable.
 */
export const refuseAuthentication = (): AppException =>
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
   * Signs a User in against an identity Google has vouched for.
   *
   * The same session as the password path — same access token, same rotating
   * refresh cookie, same `StaffPrincipal` — because Google is an authentication
   * *method* onto an existing User, not a second identity system. Everything
   * downstream of this method is unable to tell which credential got the person
   * here, and that is the point.
   *
   * **Nothing here creates a User.** The invite is the single source of truth for
   * membership, so a verified Google identity with no matching row is refused
   * exactly as an unknown password would be. Auto-provisioning would mean anyone
   * with a Google account and a tenant id could join a tenant that never invited
   * them.
   *
   * Two lookups in a deliberate order:
   *
   * 1. **By subject**, for a User who has signed in this way before. Google's
   *    `sub` is stable and never reassigned, so it survives the person changing
   *    the address on their Google account — which the email lookup would not.
   * 2. **By email**, for the first time, which is the binding the ticket is
   *    about. Verified, and against `(tenantId, email)` — so the same person at
   *    two tenants stays two Users, each of which links separately.
   *
   * The link is written on that first success. It is the step that makes 1
   * possible, and it is why a password User and a Google User are never two rows.
   *
   * Two refusals guard the second lookup, because binding by email is the step
   * that trusts something outside this system:
   *
   * - **A row already linked to another Google account** is refused, never
   *   re-pointed. A verified email proves control of an address today, not
   *   continuity with whoever held it before.
   * - **An unusable invitation** is refused, and a live one is *spent*. Signing
   *   in with Google is how an invited person accepts, so the same verdict the
   *   acceptance endpoint reaches has to be reached here — otherwise Google
   *   would be the way around an invitation that expired.
   */
  async signInWithGoogle(input: {
    tenantId: string;
    identity: GoogleIdentity;
  }): Promise<Session> {
    const now = new Date();

    const session = await this.tenancy.withTenant(
      systemContextFor(input.tenantId),
      async (tx) => {
        // Both reads run inside the tenant context, so "no such User" and "a
        // User at another tenant" are the same answer at the database level
        // rather than by care taken here.
        const linked = await tx.user.findFirst({
          where: { googleSubject: input.identity.subject },
        });

        const user =
          linked ??
          (await tx.user.findFirst({ where: { email: input.identity.email } }));

        if (!user) return null;

        // A User already linked to a *different* Google account, reached by
        // email. Refused rather than re-pointed, and this is the sharp edge of
        // the whole binding: a verified email proves the holder controls that
        // address today, not that they are who held it when the link was made.
        // Addresses get transferred and Workspace accounts get recreated, so
        // overwriting here would let a second Google account silently displace
        // the first on somebody else's staff row. Linking is a one-way step;
        // undoing it is an administrative act, not a sign-in.
        if (
          user.googleSubject &&
          user.googleSubject !== input.identity.subject
        ) {
          this.logger.warn(
            `Refused a Google sign-in for user ${user.id}: the row is linked to another Google account.`,
          );

          return null;
        }

        // Signing in with Google *is* accepting the invitation, which is the
        // point of the ticket — an invited person should not have to set a
        // password they will never use in order to use Google. So the same
        // verdict the acceptance endpoint reaches has to be reached here, or
        // Google would be a way around an expired invitation: the User row
        // outlives its invitation, and the password path refuses one only
        // because there is no hash to compare against.
        //
        // A User with no invitation at all is not part of this — the relation is
        // optional, and a seeded User was provisioned by something that never
        // issued one.
        const invitation = await tx.staffInvitation.findFirst({
          where: { userId: user.id },
        });

        if (invitation && !invitation.acceptedAt) {
          if (classifyInvitation(invitation, now).outcome === 'reject') {
            this.logger.warn(
              `Refused a Google sign-in for user ${user.id}: the invitation is unusable.`,
            );

            return null;
          }

          // Conditional on the invitation still being unspent, exactly as
          // `InvitationService.accept` is and for the same reason: this is what
          // makes acceptance single-use, rather than the check above it.
          const spent = await tx.staffInvitation.updateMany({
            where: { id: invitation.id, acceptedAt: null },
            data: { acceptedAt: now },
          });

          if (spent.count === 0) return null;
        }

        // Write the link only when it is new. An unconditional update would
        // touch `updatedAt` on every sign-in, turning a read-shaped operation
        // into a write that contends with whatever else is editing the row.
        if (!user.googleSubject) {
          await tx.user.update({
            where: { id: user.id },
            data: { googleSubject: input.identity.subject },
          });
        }

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
    if (!session) throw refuseAuthentication();

    return {
      ...session,
      accessToken: await this.accessTokens.sign(session.principal),
    };
  }
}
