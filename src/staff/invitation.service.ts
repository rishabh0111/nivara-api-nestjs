import { Injectable, Logger } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { PasswordService } from '../auth/password.service';
import {
  RequestPrincipal,
  systemContextFor,
  tenantContextFor,
} from '../auth/request-principal';
import { AppException } from '../common/errors/app-exception';
import { UserRole } from '../generated/prisma/client';
import { TenancyService } from '../tenancy/tenancy.service';
import {
  classifyInvitation,
  invitationExpiryFor,
} from './invitation-lifecycle';

/** 32 bytes of CSPRNG output, like a refresh token: a lookup key, no claims. */
const TOKEN_BYTES = 32;

/**
 * `sha256`, for the reason `RefreshTokenService` gives: the value is
 * high-entropy already, so a slow hash defends against nothing. What matters is
 * only that the stored form is not itself usable.
 */
const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

export interface IssuedInvitation {
  id: string;
  userId: string;
  email: string;
  role: UserRole;
  /** The one raw copy. It exists nowhere else, including in the database. */
  token: string;
  expiresAt: Date;
}

/**
 * Provisioning staff into a tenant.
 *
 * Membership is deliberate here — there is no self-service path into a tenant
 * anywhere in this API, so this service is the only door. Two halves, with the
 * asymmetry that implies: issuing requires an authenticated admin, and
 * accepting is done by someone who has no credential at all yet.
 */
@Injectable()
export class InvitationService {
  private readonly logger = new Logger(InvitationService.name);

  constructor(
    private readonly tenancy: TenancyService,
    private readonly passwords: PasswordService,
  ) {}

  /**
   * Issues an invitation, creating the pending User it provisions.
   *
   * The whole thing runs in the inviting admin's own tenant context, which is
   * what makes the tenant unforgeable: the User row and the invitation row are
   * both written under `WITH CHECK` on the admin's `tenantId`, so even a bug
   * that tried to stamp another tenant's id would be refused by Postgres rather
   * than by this code remembering to check.
   *
   * The User exists before any credential does — that is the shape ticket 03
   * left room for with a nullable `passwordHash`, and it is why an invited
   * person cannot sign in until they accept: there is nothing to compare a
   * password against.
   */
  async invite(
    principal: RequestPrincipal,
    input: { email: string; name: string; role: UserRole },
  ): Promise<IssuedInvitation> {
    const now = new Date();
    const token = randomBytes(TOKEN_BYTES).toString('base64url');

    return this.tenancy.withTenant(tenantContextFor(principal), async (tx) => {
      // No read-then-write check on the address. `@@unique([tenantId, email])`
      // is the only answer that is true at the instant the row is written; a
      // prior `findFirst` would let two concurrent invites for one address both
      // pass, and the loser would surface as an uncaught constraint violation —
      // a 500 where the contract promises a `conflict`.
      //
      // Safe to report as a conflict, unlike almost every other existence
      // answer in this API: the caller is an authenticated admin of this tenant
      // asking about their own tenant's staff, so no membership is disclosed to
      // anyone who did not already have it.
      const user = await tx.user
        .create({
          data: {
            tenantId: principal.tenantId,
            email: input.email,
            name: input.name,
            role: input.role,
          },
        })
        .catch((error: unknown) => {
          if (isUniqueViolation(error)) {
            throw new AppException(
              'conflict',
              `${input.email} is already a member of this tenant.`,
            );
          }

          throw error;
        });

      const invitation = await tx.staffInvitation.create({
        data: {
          tenantId: principal.tenantId,
          userId: user.id,
          tokenHash: hashToken(token),
          // Server-stamped from the credential, never from the body: the
          // audit answer to "who let this person in" must not be forgeable.
          invitedById: principal.userId,
          expiresAt: invitationExpiryFor(now),
        },
      });

      return {
        id: invitation.id,
        userId: user.id,
        email: user.email,
        role: user.role,
        token,
        expiresAt: invitation.expiresAt,
      };
    });
  }

  /**
   * Spends an invitation and sets the invitee's password.
   *
   * Runs under the `system` actor, because there is nobody to attribute it to
   * yet — the person accepting has no credential until this call succeeds, and
   * naming them as the actor would assert an identity from the unvalidated half
   * of the request.
   *
   * Three steps rather than one transaction, and the ordering carries two
   * separate concerns:
   *
   * **The token is checked before the password is hashed.** This endpoint is
   * public, and argon2 is deliberately expensive — hashing first would let
   * anyone turn a stream of invented tokens into a stream of full argon2
   * computations. A rejected token now costs one indexed lookup. (The reverse
   * ordering is right on *sign-in*, where the hash has to run even for an
   * unknown address to keep the timing uninformative. Here there is nothing to
   * conceal: the invitation is refused identically either way.)
   *
   * **The hash happens outside any transaction.** Holding one open for the
   * length of an argon2 is a pooled connection spent doing no database work.
   *
   * The check is therefore not atomic with the write — so the write does not
   * rely on it. `spend()` is conditional on the invitation still being unspent,
   * which is what actually makes acceptance single-use.
   */
  async accept(input: {
    tenantId: string;
    token: string;
    password: string;
  }): Promise<void> {
    const now = new Date();
    const tokenHash = hashToken(input.token);

    const invitation = await this.tenancy.withTenant(
      systemContextFor(input.tenantId),
      (tx) => tx.staffInvitation.findFirst({ where: { tokenHash } }),
    );

    if (!invitation) throw refuse();

    const verdict = classifyInvitation(invitation, now);

    if (verdict.outcome === 'reject') {
      this.logger.warn(
        `Refused an invitation for tenant ${input.tenantId}: ${verdict.reason}.`,
      );
      throw refuse();
    }

    const passwordHash = await this.passwords.hash(input.password);

    await this.tenancy.withTenant(
      systemContextFor(input.tenantId),
      async (tx) => {
        // Conditional on the invitation still being unspent, so two concurrent
        // acceptances cannot both set a password — exactly one updates a row,
        // and the loser is refused as a replayed token would be. This, not the
        // check above, is what enforces single use.
        const spent = await tx.staffInvitation.updateMany({
          where: { id: invitation.id, acceptedAt: null },
          data: { acceptedAt: now },
        });

        if (spent.count === 0) throw refuse();

        // `userId` comes off the invitation row, never from the request: the
        // secret says which seat is being claimed, and the claimant has no say.
        await tx.user.update({
          where: { id: invitation.userId },
          data: { passwordHash },
        });
      },
    );
  }
}

/**
 * One refusal for every way an invitation can fail.
 *
 * Unknown, expired, and already-accepted are the same fact to the person
 * holding the link — this does not work, ask your admin — and distinguishing
 * them would let anyone with a guessed token learn whether a seat exists and
 * whether it has been filled.
 */
const refuse = (): AppException =>
  new AppException(
    'unauthenticated',
    'This invitation is not valid. Ask an administrator to send a new one.',
  );

/**
 * Whether a write lost a race against a unique index.
 *
 * `P2002` is Prisma's code for a unique-constraint violation. Matched
 * structurally rather than with `instanceof`, because the generated client's
 * error classes are not the ones a test double or a future client version
 * would necessarily construct — and getting this wrong turns a conflict back
 * into the 500 it is here to prevent.
 */
const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === 'P2002';
