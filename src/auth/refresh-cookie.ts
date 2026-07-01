import { CookieOptions, Response } from 'express';
import { isTenantIdShaped } from '../tenancy/tenant-context';
import { SLIDING_WINDOW_MS } from './refresh-token-lifecycle';

/**
 * Which surface a refresh cookie belongs to.
 *
 * Both halves are load-bearing and both were, briefly, wrong.
 *
 * **`path`** scopes the cookie to the routes that consume it, so ordinary API
 * calls do not carry the credential at all. That scoping is a prefix match a
 * *browser* performs, which makes a wrong path a bug no server-side test
 * notices: a test that reads `set-cookie` and replays it by hand ignores `Path`
 * entirely and passes against a cookie no real client would ever send. The
 * portal's routes live under `/portal/auth`, which `/auth` does not prefix, so
 * one shared path would have left every portal session dying silently at
 * fifteen minutes with no way to refresh.
 *
 * **`name`** differs so the two sessions can coexist in one browser. The same
 * person can legitimately be staff at a tenant and a customer of another — and
 * more mundanely, anyone demoing this holds both at once. One name would mean
 * whichever surface signed in last silently evicted the other's cookie, which
 * reads as a random logout rather than as anything anyone would think to
 * report.
 */
export interface RefreshCookieSurface {
  name: string;
  path: string;
}

export const STAFF_REFRESH_COOKIE: RefreshCookieSurface = {
  name: 'nivara_refresh',
  path: '/auth',
};

export const PORTAL_REFRESH_COOKIE: RefreshCookieSurface = {
  name: 'nivara_portal_refresh',
  path: '/portal/auth',
};

/**
 * The staff cookie's name, kept as a bare export for the OpenAPI security
 * scheme and the tests that assert on the wire format.
 */
export const REFRESH_COOKIE = STAFF_REFRESH_COOKIE.name;

const SEPARATOR = '.';

/**
 * Packs the tenant a refresh token belongs to alongside the token itself.
 *
 * The tenant is not a credential and is not treated as one. A refresh token is
 * opaque, so finding its row means a `SELECT` — and every `SELECT` runs under
 * row-level security, which needs a tenant before it can return anything. The
 * token cannot supply one: carrying no claims is the whole point of it.
 *
 * So the tenant travels with it as a routing hint. Naming a tenant grants
 * nothing — the lookup still has to find a matching hash *inside* that tenant,
 * and a token quoted against the wrong tenant matches no row and is refused
 * exactly like an invented one. The authority is the token; this only says
 * where to look for it.
 */
export const encodeRefreshCookie = (tenantId: string, token: string): string =>
  `${tenantId}${SEPARATOR}${token}`;

/** Unpacks what `encodeRefreshCookie` wrote, or `null` if it is not that. */

export const decodeRefreshCookie = (
  value: string | undefined,
): { tenantId: string; token: string } | null => {
  if (!value) return null;

  const separator = value.indexOf(SEPARATOR);

  if (separator <= 0) return null;

  const tenantId = value.slice(0, separator);
  const token = value.slice(separator + 1);

  if (token === '') return null;

  // Checked here rather than left to `withTenant()`. It rejects a malformed
  // tenant id too, but by raising `InvalidTenantContextError` — which is
  // deliberately not an `AppException`, because everywhere else a bad tenant
  // id means a call site skipped the credential and 500 is the honest answer.
  // A cookie is the one place it means bad *input*, and input a client
  // controls must never be able to choose the server's error code.
  if (!isTenantIdShaped(tenantId)) return null;

  return { tenantId, token };
};

/**
 * The cookie the browser never gets to read.
 *
 * `httpOnly` is what keeps a page script — an XSS payload, a third-party tag —
 * from lifting the credential; combined with hashed-at-rest storage it means
 * neither a database read nor injected script yields a usable token. `Path` is
 * narrowed to the routes that consume it, so ordinary API calls do not carry it
 * at all, and `sameSite: 'lax'` keeps a cross-site request from silently
 * minting a session.
 */
export const refreshCookieOptions = (
  surface: RefreshCookieSurface,
  secure: boolean,
): CookieOptions => ({
  httpOnly: true,
  secure,
  sameSite: 'lax',
  path: surface.path,
  maxAge: SLIDING_WINDOW_MS,
});

export const setRefreshCookie = (
  response: Response,
  surface: RefreshCookieSurface,
  value: string,
  secure: boolean,
): void => {
  response.cookie(surface.name, value, refreshCookieOptions(surface, secure));
};

/**
 * Clears the cookie on sign-out and on any refusal to refresh.
 *
 * Cleared on refusal too, and deliberately: a client holding a token the
 * server will never accept again would otherwise retry it on a timer forever,
 * and each retry after an eviction looks like fresh theft in the logs.
 *
 * The surface must match the one that set it. A browser keys a cookie by name
 * *and* path, so clearing with the wrong path deletes nothing and leaves the
 * dead credential in place.
 */
export const clearRefreshCookie = (
  response: Response,
  surface: RefreshCookieSurface,
  secure: boolean,
): void => {
  const options = refreshCookieOptions(surface, secure);

  delete options.maxAge;

  response.clearCookie(surface.name, options);
};

/**
 * Reads this surface's refresh cookie off a request.
 *
 * Shared by both controllers rather than copied into each, which is what keeps
 * the `cookie-parser` narrowing honest — its `Request['cookies']` is `any`, and
 * one place that turns it back into a `string | undefined` is one place to get
 * that right.
 */
export const readRefreshCookie = (
  request: { cookies?: unknown },
  surface: RefreshCookieSurface,
): string | undefined => {
  const cookies = request.cookies as Record<string, unknown> | undefined;
  const value = cookies?.[surface.name];

  return typeof value === 'string' ? value : undefined;
};
