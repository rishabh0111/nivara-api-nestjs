import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import {
  ContactPrincipal,
  WidgetPrincipal,
  systemContextFor,
} from '../auth/request-principal';
import { AppException } from '../common/errors/app-exception';
import { AppConfigService } from '../config/app-config.service';
import { TenancyService, TenantClient } from '../tenancy/tenancy.service';
import { originIsAllowed } from './origin-allowlist';
import {
  WIDGET_SESSION_TTL_SECONDS,
  WIDGET_TOKEN_AUDIENCE,
  WIDGET_TOKEN_ISSUER,
  WIDGET_TOKEN_PREFIX,
  WidgetSessionClaims,
  sessionFromClaims,
  stripWidgetPrefix,
} from './widget-session-token';

/** A minted or renewed session, as the widget receives it. */
export interface WidgetSessionGrant {
  token: string;
  expiresInSeconds: number;
}

/**
 * The refusal a page that may not speak for this tenant receives.
 *
 * A tenant that does not exist, a tenant with the widget switched off, and a
 * page that is not on the allowlist are the same answer, because every
 * distinction between them is a fact about a tenant offered to a caller with no
 * credential — including, in the first case, whether a given uuid names a
 * customer of this service at all.
 */
const refuseOrigin = (): AppException =>
  new AppException(
    'forbidden',
    'This origin may not start a widget session for this tenant.',
  );

/**
 * Anonymous sessions: minting them, verifying them, and resolving them to a
 * Contact at the last possible moment.
 *
 * Three properties are worth stating together, because they are what make an
 * unauthenticated surface safe to expose:
 *
 * **The tenant is signed, never asserted.** It arrives from the caller exactly
 * once — in the bootstrap body, where it is a routing input, not an authority
 * claim, and where naming it still requires passing the Origin gate. From the
 * moment a token is minted the tenant comes from the token, so a session signed
 * for one tenant cannot act on another. That is the same rule staff and portal
 * sign-in follow; there is nothing weaker about it here.
 *
 * **Revocation is stateful.** Every widget request reads the session row, so a
 * killed session stops working on its next request rather than at expiry. That
 * is a per-request query the staff path deliberately avoids, and it is bought
 * on purpose: fifteen minutes of a compromised staff token is a bounded
 * problem, but "stop this abusive visitor" has no answer at all without it.
 *
 * **The Contact is lazy.** A visitor who opens the widget and reads leaves
 * nothing durable about themselves behind. The Contact row appears on the first
 * act that needs a requester, which is what keeps the path from anonymous
 * visitor to lasting identity open — and is the seam a later identity merge
 * lands on.
 */
@Injectable()
export class WidgetSessionService {
  constructor(
    private readonly tenancy: TenancyService,
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
  ) {}

  /**
   * Mints a session for a visitor, if their page is allowed to ask.
   *
   * The tenant is read inside its own `systemContextFor` context, which is what
   * the portal's sign-in does and for the same reason: there is no credential
   * yet to take a tenant from, so the caller names one and the *gate* is what
   * decides whether naming it was enough. An unknown tenant simply yields no
   * row, and takes the same refusal a disallowed origin does.
   *
   * The session row and the token are produced together, the row first: a token
   * naming a row that does not exist would fail every subsequent verification,
   * which is a confusing way to fail but a safe one, whereas a row with no
   * token is merely litter that expires.
   */
  async bootstrap(input: {
    tenantId: string;
    origin: string | undefined;
  }): Promise<WidgetSessionGrant> {
    const expiresAt = expiryFrom(new Date());

    const sessionId = await this.tenancy.withTenant(
      systemContextFor(input.tenantId),
      async (tx) => {
        if (!(await originPasses(tx, input.tenantId, input.origin)))
          return null;

        const session = await tx.widgetSession.create({
          data: {
            tenantId: input.tenantId,
            // Stated rather than defaulted, because it is the whole point: a
            // visitor who never opens a Ticket leaves no Contact behind.
            contactId: null,
            expiresAt,
          },
        });

        return session.id;
      },
    );

    if (!sessionId) throw refuseOrigin();

    return this.grantFor(sessionId, input.tenantId, expiresAt);
  }

  /**
   * A presented token reduced to a principal, or `null`.
   *
   * `null` for every rejection alike — a bad signature, an expired JWT, a
   * revoked row, a row that has expired, a row that is gone — because they are
   * one fact to the caller: no usable session. `AuthGuard` turns that into the
   * same 401 an absent credential gets.
   *
   * Both clocks are checked, and they are not the same check. The JWT's `exp`
   * is what makes a stolen token stop working without a database round trip;
   * the row's `expiresAt` is the authority, and it is what renewal moves. They
   * are written together and normally agree — the row is consulted anyway, so
   * the cost of asking both is nothing, and the case where they disagree is
   * exactly the one worth catching.
   */
  async verify(raw: string): Promise<WidgetPrincipal | null> {
    let claims: unknown;

    try {
      claims = await this.jwt.verifyAsync<object>(stripWidgetPrefix(raw), {
        secret: this.config.widgetSessionSecret,
        issuer: WIDGET_TOKEN_ISSUER,
        audience: WIDGET_TOKEN_AUDIENCE,
        algorithms: ['HS256'],
      });
    } catch {
      return null;
    }

    const ref = sessionFromClaims(claims);

    if (!ref) return null;

    // `systemContextFor`, because there is no actor yet — the whole point of
    // this read is to find out whether there is one. It is the same honest
    // answer sign-in gives: the server did this on its own account.
    const session = await this.tenancy.withTenant(
      systemContextFor(ref.tenantId),
      (tx) => tx.widgetSession.findFirst({ where: { id: ref.sessionId } }),
    );

    if (!session) return null;
    if (session.revokedAt) return null;
    if (session.expiresAt <= new Date()) return null;

    return {
      kind: 'widget',
      tenantId: ref.tenantId,
      sessionId: session.id,
      // From the row, never from the token. A Contact resolved a moment ago on
      // another request is visible here immediately, and a token claiming one
      // the server did not write is not believed.
      contactId: session.contactId,
    };
  }

  /**
   * Extends a live session and issues a fresh token for it.
   *
   * The session id is kept, which is what makes this a renewal rather than a
   * new session: the resolved Contact, and therefore the visitor's Tickets,
   * survive it. A conversation that runs past thirty minutes is one
   * conversation.
   *
   * The Origin gate is applied again, on the argument that a token lifted onto
   * another page should not be able to keep itself alive from there
   * indefinitely. It costs a tenant read that the verification already
   * implies, and it closes the gap where the allowlist bounds only the first
   * thirty minutes of a session's life.
   *
   * The two failures answer *differently*, unlike the bootstrap endpoint where
   * every refusal is one answer. The reasoning that fuses them there does not
   * apply here: this caller already holds a valid session for this tenant, so
   * "your origin is not allowed" tells them nothing they could not learn by
   * calling bootstrap, and there is no longer any tenant existence to conceal.
   * What is left is a genuine distinction a client should act on — 403 means
   * stop trying from this page, 401 means this session is over and a new one is
   * needed — and collapsing it would leave a widget retrying a renewal that can
   * never succeed.
   */
  async renew(
    principal: WidgetPrincipal,
    origin: string | undefined,
  ): Promise<WidgetSessionGrant> {
    const expiresAt = expiryFrom(new Date());

    const outcome = await this.tenancy.withTenant(
      systemContextFor(principal.tenantId),
      async (tx) => {
        if (!(await originPasses(tx, principal.tenantId, origin))) {
          return 'origin-refused' as const;
        }

        // `updateMany` with the liveness predicate in the `where`, rather than
        // a read followed by an update. A session revoked between this
        // request's verification and this statement must not be renewed back
        // into life, and a compare-and-set is what makes that a lost race
        // instead of a hole.
        const { count } = await tx.widgetSession.updateMany({
          where: { id: principal.sessionId, revokedAt: null },
          data: { expiresAt },
        });

        return count === 1 ? ('renewed' as const) : ('session-dead' as const);
      },
    );

    if (outcome === 'origin-refused') throw refuseOrigin();

    if (outcome === 'session-dead') {
      throw new AppException(
        'unauthenticated',
        'This widget session can no longer be renewed. Start a new one.',
      );
    }

    return this.grantFor(principal.sessionId, principal.tenantId, expiresAt);
  }

  /**
   * The session's Contact, creating one if this is the first act that needs a
   * requester.
   *
   * The write path calls this; the read path calls `existingContactPrincipal`
   * below. Keeping them as two methods rather than one with a flag is what
   * makes "anonymous until it matters" checkable by reading call sites: a read
   * endpoint that quietly created a Contact would violate the ticket's promise,
   * and here it could only do so by calling the obviously-named method.
   *
   * `SELECT ... FOR UPDATE` on the session row, because two requests arriving
   * together from one visitor — the widget opening a Ticket while a retry does
   * the same — would otherwise each create a Contact, and the conversation
   * would split across two identities that nothing in this API can merge. The
   * lock serializes them: the second waits, then finds the first's Contact
   * already written. It is held for the width of this transaction only.
   */
  async contactPrincipalFor(
    principal: WidgetPrincipal,
  ): Promise<ContactPrincipal> {
    if (principal.contactId)
      return contactPrincipal(principal.contactId, principal.tenantId);

    const contactId = await this.tenancy.withTenant(
      systemContextFor(principal.tenantId),
      async (tx) => {
        const locked = await lockSession(tx, principal.sessionId);

        // The session was revoked or reaped between verification and here.
        if (!locked) return null;
        if (locked.contact_id) return locked.contact_id;

        // Anonymous in every column: no email, no name, unverified, and no
        // portal credential. Identifying themselves later is a write to this
        // row; it is not a different kind of Contact.
        const contact = await tx.contact.create({
          data: { tenantId: principal.tenantId },
        });

        await tx.widgetSession.update({
          where: { id: principal.sessionId },
          data: { contactId: contact.id },
        });

        return contact.id;
      },
    );

    if (!contactId) {
      throw new AppException(
        'unauthenticated',
        'This widget session is no longer valid.',
      );
    }

    return contactPrincipal(contactId, principal.tenantId);
  }

  /**
   * The session's Contact if it has one, and `null` rather than a new one.
   *
   * What the read endpoints use. A visitor who has said nothing owns no
   * Tickets, so the honest answer to "list my Tickets" is an empty page — and
   * producing it must not cost them a durable row. Creating a Contact in order
   * to discover it has nothing is the exact failure the ticket's "nothing
   * durable is stored before they identify themselves" rules out.
   */
  existingContactPrincipal(
    principal: WidgetPrincipal,
  ): ContactPrincipal | null {
    return principal.contactId
      ? contactPrincipal(principal.contactId, principal.tenantId)
      : null;
  }

  private async grantFor(
    sessionId: string,
    tenantId: string,
    expiresAt: Date,
  ): Promise<WidgetSessionGrant> {
    const claims: WidgetSessionClaims = {
      kind: 'widget',
      sub: sessionId,
      tenantId,
    };

    const token = await this.jwt.signAsync(claims, {
      secret: this.config.widgetSessionSecret,
      issuer: WIDGET_TOKEN_ISSUER,
      audience: WIDGET_TOKEN_AUDIENCE,
      // Seconds from now rather than the absolute `expiresAt`, so the JWT's own
      // clock and the row's agree to the second they were both derived from.
      expiresIn: WIDGET_SESSION_TTL_SECONDS,
    });

    return {
      token: `${WIDGET_TOKEN_PREFIX}${token}`,
      expiresInSeconds: Math.max(
        0,
        Math.round((expiresAt.getTime() - Date.now()) / 1000),
      ),
    };
  }
}

const contactPrincipal = (
  contactId: string,
  tenantId: string,
): ContactPrincipal => ({ kind: 'contact', tenantId, contactId });

/**
 * Whether this page may speak for this tenant's widget.
 *
 * One function rather than the same three lines in `bootstrap` and `renew`,
 * because "the allowlist is checked again on renewal" should be a single fact
 * that is true or false, not two copies that agree today. The interesting way
 * for them to drift is silent: relax the gate at mint and forget renewal, and
 * the allowlist quietly bounds only the first thirty minutes of a session.
 *
 * Both refusals collapse here. A tenant that does not exist and a tenant whose
 * `widgetOrigins` is empty — the "widget is off" case — need no branch of their
 * own: `originIsAllowed` answers false for an empty list, and a missing tenant
 * never reaches it.
 */
const originPasses = async (
  tx: TenantClient,
  tenantId: string,
  origin: string | undefined,
): Promise<boolean> => {
  const tenant = await tx.tenant.findFirst({ where: { id: tenantId } });

  return !!tenant && originIsAllowed(origin, tenant.widgetOrigins);
};

const expiryFrom = (now: Date): Date =>
  new Date(now.getTime() + WIDGET_SESSION_TTL_SECONDS * 1000);

/**
 * The session row, locked for the width of the caller's transaction.
 *
 * Raw SQL because `FOR UPDATE` has no expression in Prisma's query API, and the
 * lock is the entire reason for the read — a `findFirst` here would be a read
 * that races. Row-level security still applies: this runs inside an armed
 * transaction, so the tenant policy scopes it exactly as it would a Prisma
 * query.
 */
const lockSession = async (
  tx: TenantClient,
  sessionId: string,
): Promise<{ contact_id: string | null } | undefined> => {
  const rows = await tx.$queryRaw<{ contact_id: string | null }[]>`
    SELECT contact_id::text FROM widget_session
    WHERE id = ${sessionId}::uuid AND revoked_at IS NULL
    FOR UPDATE
  `;

  return rows[0];
};
