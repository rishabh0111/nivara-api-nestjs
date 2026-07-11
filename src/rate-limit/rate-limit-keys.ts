import { principalRef } from '../auth/principal-ref';
import { RequestPrincipal } from '../auth/request-principal';

/**
 * The namespace every rate-limit counter lives under.
 *
 * A constant rather than three inline string literals, so "which keys are
 * these" is answerable by reading one line — and so the cache seam that will
 * share this Redis instance can be given a prefix that demonstrably does not
 * collide with it.
 */
const RATE_LIMIT_PREFIX = 'rl';

/**
 * The counter one authenticated principal is charged against.
 *
 * The tenant is in the key for isolation and nothing else. There is no
 * per-tenant ceiling — every principal gets the same budget — so the prefix's
 * whole job is to make one tenant's traffic incapable of consuming another's.
 * That is a property of the key rather than of a filter somewhere, which is the
 * same shape the rest of this system's tenant isolation takes.
 *
 * Both halves are server-determined: `tenantId` comes from the validated
 * credential and so does the principal reference. There is deliberately no
 * argument here a request body could reach.
 */
export const authenticatedKey = (
  principal: RequestPrincipal,
  bucket: number,
): string =>
  `${RATE_LIMIT_PREFIX}:auth:${principal.tenantId}:${principalRef(principal)}:${bucket}`;

/**
 * The counter one address is charged against on the public Slack route.
 *
 * No tenant, and that is the point rather than an oversight. This runs before
 * the signature is verified, so no tenant is known yet — the only thing that
 * could name one is the payload's own claim about its workspace, which is
 * precisely the unverified input a pre-trust limiter must not read. Keying on
 * it would let a flood pick which tenant's budget to exhaust.
 */
export const slackIpKey = (ip: string, bucket: number): string =>
  `${RATE_LIMIT_PREFIX}:slack:ip:${ip}:${bucket}`;

/**
 * The coarse backstop for the whole Slack route.
 *
 * One counter, taking no address at all, because its job is the case the
 * per-IP ceiling cannot cover: a flood spread thinly across many addresses,
 * where every individual bucket stays under its limit. Set well above the
 * per-IP ceiling, so it is reached only by an aggregate no legitimate workspace
 * produces.
 */
export const slackGlobalKey = (bucket: number): string =>
  `${RATE_LIMIT_PREFIX}:slack:global:${bucket}`;
