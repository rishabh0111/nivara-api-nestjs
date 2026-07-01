import { Injectable, Logger } from '@nestjs/common';
import { AccessTokenService } from '../auth/access-token.service';
import { PasswordService } from '../auth/password.service';
import { RefreshTokenService } from '../auth/refresh-token.service';
import {
  ContactPrincipal,
  systemContextFor,
  tenantContextFor,
} from '../auth/request-principal';
import { rotateRefreshSession } from '../auth/session-rotation';
import { AppException } from '../common/errors/app-exception';
import { TenancyService } from '../tenancy/tenancy.service';

/** What a portal sign-in or refresh produces. Mirrors the staff `Session`. */
export interface PortalSession {
  principal: ContactPrincipal;
  accessToken: string;
  refreshToken: string;
}

/**
 * The one error every portal authentication failure becomes.
 *
 * Wrong password, unknown address, an address belonging to another tenant, and
 * — the case with no staff equivalent — a Contact that exists but has no
 * credential at all, which is the ordinary state of anyone who has only ever
 * used the widget. Every distinction the response could draw is a fact about
 * who is a customer of which tenant, offered to whoever asked without one.
 */
const refuse = (): AppException =>
  new AppException('unauthenticated', 'Invalid credentials.');

/**
 * Signing a Contact into the portal.
 *
 * A separate service from `AuthService` rather than a branch inside it, and the
 * separation is the point rather than tidiness. The two resolve different
 * tables, mint principals on different axes, and answer to different surfaces;
 * fused, they would be one method whose behaviour depends on which lookup
 * happened to match — and a failed staff sign-in would quietly become a probe
 * of the contact table.
 *
 * What they deliberately *do* share is everything below identity: the same
 * argon2 verifier, the same access-token minter, the same refresh ledger with
 * the same rotation and replay detection. A portal session is not a weaker
 * session. It is the same session mechanism with a Contact as its subject.
 */
@Injectable()
export class PortalAuthService {
  private readonly logger = new Logger(PortalAuthService.name);

  constructor(
    private readonly tenancy: TenancyService,
    private readonly passwords: PasswordService,
    private readonly accessTokens: AccessTokenService,
    private readonly refreshTokens: RefreshTokenService,
  ) {}

  /**
   * Signs a Contact in against `(tenantId, email)`.
   *
   * The tenant arrives from the request for the reason it does at staff
   * sign-in: there is no credential yet to read it from. It is a routing input
   * rather than an authority claim — naming a tenant decides which tenant's
   * `contact` rows the lookup can see, and seeing them still requires the
   * password. From the moment a token is issued the tenant comes from the token.
   *
   * A Contact with no `passwordHash` cannot sign in and is refused
   * indistinguishably from a wrong password. That is the common case rather
   * than an edge: every widget visitor is a credential-less Contact, and the
   * portal must not become a way to enumerate them.
   */
  async signIn(input: {
    tenantId: string;
    email: string;
    password: string;
  }): Promise<PortalSession> {
    const now = new Date();

    const session = await this.tenancy.withTenant(
      systemContextFor(input.tenantId),
      async (tx) => {
        const contact = await tx.contact.findFirst({
          where: { email: input.email.toLowerCase() },
        });

        // Runs even when there is no Contact, against a null hash, so that an
        // unknown address costs the same as a known one. See `PasswordService`.
        const valid = await this.passwords.verify(
          contact?.passwordHash ?? null,
          input.password,
        );

        if (!contact || !valid) return null;

        const principal: ContactPrincipal = {
          kind: 'contact',
          tenantId: input.tenantId,
          contactId: contact.id,
        };

        const refresh = await this.refreshTokens.issue(tx, {
          tenantId: input.tenantId,
          subject: { kind: 'contact', contactId: contact.id },
          now,
        });

        return { principal, refreshToken: refresh.token };
      },
    );

    return this.issueSession(session);
  }

  /**
   * Exchanges a portal refresh token for a new pair, rotating it.
   *
   * Literally the same sequence the staff path runs — `rotateRefreshSession`
   * owns it, so the two cannot drift on the order that matters: axis check
   * before verdict, replay before validity, re-read before mint. What is
   * portal-specific is the `expect` and the `resolve` below.
   *
   * A *staff* refresh token presented here is refused, exactly as a portal token
   * is refused at the staff endpoint, and refused without evicting its family:
   * one ledger serves both axes, so arriving at the wrong door is a client bug
   * rather than evidence of theft.
   */
  async refresh(input: {
    tenantId: string;
    token: string;
  }): Promise<PortalSession> {
    const now = new Date();

    const session = await this.tenancy.withTenant(
      systemContextFor(input.tenantId),
      (tx) =>
        rotateRefreshSession<ContactPrincipal>({
          refreshTokens: this.refreshTokens,
          tx,
          token: input.token,
          now,
          expect: 'contact',
          logger: this.logger,
          label: 'Portal refresh',
          tenantId: input.tenantId,
          // Re-read rather than trust the token: a Contact deleted mid-session
          // must not be able to refresh into another fifteen minutes.
          resolve: async (client, contactId) => {
            const contact = await client.contact.findFirst({
              where: { id: contactId },
            });

            if (!contact) return null;

            return {
              kind: 'contact',
              tenantId: input.tenantId,
              contactId: contact.id,
            };
          },
        }),
    );

    return this.issueSession(session);
  }

  /**
   * Ends a portal session by evicting its whole family.
   *
   * Idempotent and silent, as staff sign-out is: whether a given token exists
   * is not something an unauthenticated caller should learn from a status code.
   *
   * Deliberately does *not* check the subject kind. Presenting a staff token
   * here revokes that family — which is the right outcome, because the caller
   * asked for a session to end and it is their own token; refusing would leave
   * a live session behind on a technicality.
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
   * The Contact behind a principal, read inside that principal's own tenant.
   *
   * A database read rather than an echo of the token's claims, for the reason
   * `AuthService.currentUser` gives: it is the cheapest end-to-end proof that
   * the token's `tenantId` reaches row-level security, since the row is only
   * visible from inside the context the token armed.
   */
  async currentContact(principal: ContactPrincipal): Promise<{
    id: string;
    email: string | null;
    name: string | null;
    verified: boolean;
  }> {
    const contact = await this.tenancy.withTenant(
      tenantContextFor(principal),
      (tx) => tx.contact.findFirst({ where: { id: principal.contactId } }),
    );

    // A token outliving its Contact — deleted inside the fifteen minutes the
    // access token stays valid for.
    if (!contact) throw AppException.notFound('Contact');

    return contact;
  }

  private async issueSession(
    session: { principal: ContactPrincipal; refreshToken: string } | null,
  ): Promise<PortalSession> {
    if (!session) throw refuse();

    return {
      ...session,
      accessToken: await this.accessTokens.sign(session.principal),
    };
  }
}
