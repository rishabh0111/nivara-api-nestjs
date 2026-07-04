import { Injectable } from '@nestjs/common';
import {
  ServicePrincipal,
  StaffPrincipal,
  systemContextFor,
  tenantContextFor,
} from '../auth/request-principal';
import { AuditService } from '../audit/audit.service';
import { classifyScopes, grantedScopes } from '../authz/service-scopes';
import { AppException } from '../common/errors/app-exception';
import { Permission } from '../authz/permissions';
import { ServiceToken } from '../generated/prisma/client';
import { TenancyService } from '../tenancy/tenancy.service';
import { mintServiceToken, parseServiceToken } from './service-token-format';

/** A freshly minted token: the row, plus the one raw copy that will exist. */
export interface MintedToken {
  token: ServiceToken;
  /** Shown once. It exists nowhere else, including in the database. */
  raw: string;
}

export interface MintTokenInput {
  name: string;
  scopes: string[];
}

/**
 * Minting, listing, revoking and verifying tenant-scoped machine credentials.
 *
 * The service the AI layer's authority passes through, and the one place four
 * separate guarantees are kept:
 *
 * **The raw token exists once.** It is generated, hashed, and the hash is what
 * is written. Nothing here can hand it back afterwards, because nothing here
 * has it — a lost token is reminted, and that is not a limitation to work
 * around later.
 *
 * **Provenance is stamped, never accepted.** Tenant and creator come off the
 * minting admin's own credential, and the write runs inside their tenant
 * context, so even a bug that tried to stamp another tenant would be refused by
 * Postgres's `WITH CHECK` rather than by this code remembering to look.
 *
 * **Scopes are the staff vocabulary.** `classifyScopes` at mint, `grantedScopes`
 * on every read — see `service-scopes.ts` for why both, and why the second is
 * not merely belt-and-braces.
 *
 * **Revocation has no delay.** `verify()` reads the row on every request and
 * there is no cache in the path. That read is the cost of the guarantee, and it
 * is the guarantee that is worth having.
 */
@Injectable()
export class ServiceTokenService {
  constructor(
    private readonly tenancy: TenancyService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Mints a token for the admin's own tenant.
   *
   * Takes a `StaffPrincipal` rather than the whole union, for the reason
   * `InvitationService.invite` does: the row records *which User* minted it, and
   * no other principal has an id that could stand in. The route already requires
   * `token:manage`, which is un-grantable to a machine and held by no Contact,
   * so this narrowing adds no runtime check — it stops the type from claiming a
   * caller shape this method could not serve.
   *
   * The token is generated before the transaction opens and the audit row is
   * written inside it, so a mint that rolls back leaves neither a usable
   * credential nor a claim that one was issued.
   */
  async mint(
    principal: StaffPrincipal,
    input: MintTokenInput,
  ): Promise<MintedToken> {
    const scopes = this.acceptedScopes(input.scopes);
    const { raw, tokenHash } = mintServiceToken(principal.tenantId);

    const token = await this.tenancy.withTenant(
      tenantContextFor(principal),
      async (tx) => {
        const created = await tx.serviceToken.create({
          data: {
            tenantId: principal.tenantId,
            name: input.name,
            tokenHash,
            scopes,
            // Server-stamped from the credential, never from the body: the
            // answer to "who gave the AI layer this authority" must not be
            // forgeable by whoever is asking for the authority.
            createdById: principal.userId,
          },
        });

        // In the same transaction as the row it describes, so there is no
        // window in which a credential exists and the log does not say so.
        // The scopes are metadata rather than `toValue` because a grant is a
        // set, and the old/new columns describe a scalar moving.
        await this.audit.record(tx, {
          action: 'token_minted',
          targetKind: 'service_token',
          targetId: created.id,
          metadata: { name: created.name, scopes },
        });

        return created;
      },
    );

    return { token, raw };
  }

  /**
   * The tenant's tokens, newest first, including revoked ones.
   *
   * Revoked rows are kept in the list deliberately: the operator question is
   * "what has ever held authority here", and a token that vanishes when revoked
   * makes an incident harder to reconstruct rather than the list tidier.
   *
   * Returns rows rather than DTOs, so the hash is still on them here — it is
   * `toServiceTokenDto` at the controller that drops it, and that single mapper
   * is the only thing standing between this table and a response. Worth knowing
   * if a caller is ever added that serializes what this returns directly.
   */
  async list(principal: StaffPrincipal): Promise<ServiceToken[]> {
    return this.tenancy.withTenant(tenantContextFor(principal), (tx) =>
      tx.serviceToken.findMany({
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
    );
  }

  /**
   * Revokes a token, and says whether this call is what revoked it.
   *
   * A conditional `updateMany` rather than a read-then-write, on the same
   * argument `WidgetSessionService.renew` makes: two concurrent revocations
   * must not both write an audit row claiming to be the one that ended the
   * token's life. Exactly one updates a row; the loser is told the token is
   * already revoked.
   *
   * A token that does not exist and one belonging to another tenant are the
   * same 404, because row-level security makes them literally the same query
   * result — there is nothing here that could tell them apart even if it wanted
   * to.
   */
  async revoke(principal: StaffPrincipal, tokenId: string): Promise<void> {
    await this.tenancy.withTenant(tenantContextFor(principal), async (tx) => {
      const existing = await tx.serviceToken.findUnique({
        where: { id: tokenId },
      });

      if (!existing) throw AppException.notFound('ServiceToken');

      const { count } = await tx.serviceToken.updateMany({
        where: { id: tokenId, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      if (count === 0) {
        throw new AppException(
          'conflict',
          'This service token is already revoked. Revocation is final — mint a new token to restore access.',
        );
      }

      await this.audit.record(tx, {
        action: 'token_revoked',
        targetKind: 'service_token',
        targetId: tokenId,
        metadata: { name: existing.name },
      });
    });
  }

  /**
   * A presented token reduced to a principal, or `null`.
   *
   * `null` for every rejection alike — a malformed value, a hash on file
   * nowhere, a revoked row — because they are one fact to the caller: no usable
   * credential. `AuthGuard` turns that into the same 401 an absent credential
   * gets, and distinguishing them would tell whoever is probing which half of
   * their guess was right.
   *
   * `systemContextFor`, because there is no actor yet — the point of this read
   * is to find out whether there is one. The tenant it arms comes from the
   * token's own routing segment, which is not a claim: the hash covers that
   * segment, so a value with another tenant's id spliced in finds no row.
   *
   * No expiry is checked because there is none to check. A service token lives
   * until it is revoked, which is why the revocation read below is not
   * optional and why nothing caches it.
   */
  async verify(raw: string): Promise<ServicePrincipal | null> {
    const ref = parseServiceToken(raw);

    if (!ref) return null;

    const token = await this.tenancy.withTenant(
      systemContextFor(ref.tenantId),
      (tx) =>
        tx.serviceToken.findFirst({ where: { tokenHash: ref.tokenHash } }),
    );

    if (!token) return null;
    if (token.revokedAt) return null;

    return {
      kind: 'service',
      tenantId: token.tenantId,
      tokenId: token.id,
      // Narrowed on every read rather than trusted from the column. See
      // `grantedScopes`: this is where "no machine credential can ever hold
      // `audit:read`" stops depending on every writer having been careful.
      scopes: grantedScopes(token.scopes),
    };
  }

  /**
   * Turns a requested scope list into one that may be granted, or refuses.
   *
   * The refusals are specific because the caller is an authenticated admin
   * configuring their own tenant's integration — there is nothing to conceal
   * from them, and a bare "rejected" would leave them guessing which name was
   * the problem. Both offending classes name permissions the OpenAPI document
   * already publishes, so nothing here is disclosed that was not public.
   */
  private acceptedScopes(requested: string[]): Permission[] {
    const verdict = classifyScopes(requested);

    if (verdict.outcome === 'accept') return verdict.scopes;

    if (verdict.outcome === 'empty') {
      throw new AppException(
        'validation_failed',
        'A service token needs at least one scope. A token with none could authenticate and then do nothing.',
      );
    }

    if (verdict.outcome === 'unknown') {
      throw new AppException(
        'validation_failed',
        `Not a permission in this API: ${verdict.offending.join(', ')}. GET /service-tokens/scopes lists what may be granted.`,
      );
    }

    throw new AppException(
      'validation_failed',
      `These permissions cannot be granted to a service token: ${verdict.offending.join(', ')}. Destructive, configuration, user-management and audit-read authority is reserved to staff.`,
    );
  }
}
