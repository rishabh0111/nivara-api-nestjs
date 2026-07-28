import { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';
import { originIsAllowed } from '../../widget/origin-allowlist';

/**
 * Response headers a cross-origin caller may read.
 *
 * Everything here is a header a *correct* client is required to act on, and a
 * browser hides every response header but a handful unless it is named. The
 * rate-limit set is the one that matters: a 429 whose `Retry-After` cannot be
 * read is a 429 a client can only respond to by guessing, which is how a
 * backoff turns into a retry storm. `Idempotency-Replayed` is here so a caller
 * can tell a replayed write from a fresh one, which is the whole point of
 * having sent the key.
 */
const EXPOSED_HEADERS = [
  'Retry-After',
  'RateLimit-Limit',
  'RateLimit-Remaining',
  'RateLimit-Reset',
  'Idempotency-Replayed',
];

/**
 * How long a browser may cache a preflight. Ten minutes, which is Chrome's own
 * ceiling — a larger number is not an error, it is silently clamped, and a
 * number that reads as a decision but is not one is worse than the default.
 */
const PREFLIGHT_MAX_AGE_SECONDS = 600;

/**
 * What CORS to grant a request, decided per request rather than once at boot.
 *
 * This API serves two kinds of browser caller with incompatible needs, and one
 * static configuration cannot satisfy both.
 *
 * **First-party surfaces** — the portal and the staff dashboard — hold an
 * httpOnly refresh cookie, so their requests are credentialed. A credentialed
 * request may not be answered with a wildcard origin: the browser requires an
 * exact echo, which means the origin has to be known in advance. That is what
 * `WEB_ORIGINS` is, and it is deliberately a short list of deployments of the
 * front end rather than anything a tenant configures.
 *
 * **The widget** runs on tenants' own sites, so its origins cannot be
 * enumerated here at all. It presents a bearer token and never a cookie, so it
 * needs no credentialed CORS — and its origin is checked properly, per tenant,
 * by `originIsAllowed` inside the bootstrap endpoint.
 *
 * That second check is the reason this function can afford to reflect an
 * unknown origin. CORS is not the gate. A preflight is an `OPTIONS` with no
 * body, and the body is where `tenantId` lives, so a preflight *cannot* know
 * whose allowlist to consult even in principle — any design that put the
 * tenant's allowlist here would be enforcing it one request too early, on
 * information it does not have. What this function must never do is hand an
 * unknown origin *credentials*, because that would make the refresh cookie
 * reachable from any page on the internet.
 */
export const browserCorsPolicy = (
  /** The request's `Origin` header, absent when the caller sent none. */
  origin: string | undefined,
  /** Deployments of the front end. Exact origins, from `WEB_ORIGINS`. */
  firstPartyOrigins: readonly string[],
): CorsOptions => {
  // No `Origin` means no browser, and a non-browser caller is unaffected by
  // anything decided here. Answering with no CORS headers at all is the honest
  // response: there is nobody to grant anything to.
  if (origin === undefined) {
    return { origin: false };
  }

  const firstParty = originIsAllowed(origin, firstPartyOrigins);

  return {
    // Echoed rather than wildcarded even in the uncredentialed case, because a
    // wildcard and an echo differ for a caller that later adds credentials:
    // the echo keeps `Vary: Origin` honest and makes the credentialed and
    // uncredentialed answers the same shape.
    origin: true,
    credentials: firstParty,
    exposedHeaders: EXPOSED_HEADERS,
    maxAge: PREFLIGHT_MAX_AGE_SECONDS,
  };
};
