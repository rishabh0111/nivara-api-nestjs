import { createHash, randomBytes } from 'node:crypto';
import { isTenantIdShaped } from '../tenancy/tenant-context';

/**
 * The shape of a service token, apart from the row that gives it authority.
 *
 * Separated from the service for the reason `widget-session-token.ts` is: the
 * parsing of a presented credential is the security boundary, and it should be
 * exercisable without a key, a clock, or a database.
 *
 * Unlike the other two credentials in this API, a service token is **not** a
 * JWT. It carries no claims and no expiry, because everything that would have
 * been a claim is mutable: the scopes an admin can widen, and the revocation
 * that must take effect on the very next request. A signed claim set would put
 * a copy of those on the wire and hand the caller a version of the truth that
 * outlives the row — which is exactly the revocation delay this credential is
 * specified not to have. So the token is an opaque lookup key, the row is the
 * only source of authority, and every request reads it.
 */

/** 32 bytes of CSPRNG output, like a refresh token: a lookup key, no claims. */
const SECRET_BYTES = 32;

/**
 * What a service token bearer value is prefixed with.
 *
 * `nvk` for key, `live` because a sandbox tier is a plausible later
 * distinction and retrofitting an environment segment into a credential format
 * already in downstream configuration files is not. Purely a routing hint, on
 * exactly the terms the widget prefix is: it grants nothing, and a staff token
 * wearing it fails at the lookup a moment later.
 */
export const SERVICE_TOKEN_PREFIX = 'nvk_live_';

/**
 * Separates the tenant segment from the secret.
 *
 * A dot, and the secret's alphabet is base64url — which has no dot in it — so
 * the split is unambiguous by construction rather than by taking the first
 * occurrence and hoping.
 */
const SEPARATOR = '.';

/** A minted token: the one raw copy, and the only form ever stored. */
export interface MintedServiceToken {
  /** Shown once, to the admin who minted it. It exists nowhere else. */
  raw: string;
  tokenHash: string;
}

/** A presented token reduced to a place to look, before the row is consulted. */
export interface ServiceTokenRef {
  tenantId: string;
  tokenHash: string;
}

/**
 * `sha256`, for the reason `InvitationService` gives: the value is
 * high-entropy already, so a slow hash defends against nothing. What matters is
 * only that the stored form is not itself usable — a database dump yields
 * hashes, and a hash is not a credential.
 *
 * The *whole* presented value is hashed, tenant segment included. That is what
 * stops the routing hint from being edited: splicing another tenant's id in
 * front of a real secret produces a value that hashes to nothing on file,
 * rather than a lookup in a tenant the holder chose.
 */
export const hashServiceToken = (raw: string): string =>
  createHash('sha256').update(raw).digest('hex');

export const isServiceToken = (value: string): boolean =>
  value.startsWith(SERVICE_TOKEN_PREFIX);

/**
 * A fresh token for a tenant, and the hash to store beside it.
 *
 * The tenant id travels in the token because this credential carries no signed
 * claims to put it in, and the lookup has to know which tenant's rows to search
 * before any context can be armed. It is a routing input and never an authority
 * claim — the same standing the tenant id has in the widget's bootstrap body.
 * A caller who edits it finds no matching row, because the hash covers it.
 */
export const mintServiceToken = (tenantId: string): MintedServiceToken => {
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  const raw = `${SERVICE_TOKEN_PREFIX}${tenantId}${SEPARATOR}${secret}`;

  return { raw, tokenHash: hashServiceToken(raw) };
};

/**
 * Validates the shape of a presented token and reduces it to a lookup, or
 * `null`.
 *
 * `null` for every rejection alike — a missing prefix, an unsplittable body, a
 * tenant segment that is not a uuid — because they are one fact to the caller:
 * no usable token. `AuthGuard` turns that into the same 401 an absent
 * credential gets, and distinguishing them would describe the format to
 * whoever is probing it.
 *
 * The uuid check is not cosmetic. The tenant id reaches `withTenant()`, which
 * casts it with `::uuid`, so a malformed segment would otherwise surface as a
 * Postgres error reported as a database fault rather than as the bad credential
 * it is.
 */
export const parseServiceToken = (raw: string): ServiceTokenRef | null => {
  if (!isServiceToken(raw)) return null;

  const body = raw.slice(SERVICE_TOKEN_PREFIX.length);
  const parts = body.split(SEPARATOR);

  if (parts.length !== 2) return null;

  const [tenantId, secret] = parts;

  if (!tenantId || !secret) return null;
  if (!isTenantIdShaped(tenantId)) return null;

  return { tenantId, tokenHash: hashServiceToken(raw) };
};
