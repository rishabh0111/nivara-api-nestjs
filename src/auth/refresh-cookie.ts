import { CookieOptions, Response } from 'express';
import { isTenantIdShaped } from '../tenancy/tenant-context';
import { SLIDING_WINDOW_MS } from './refresh-token-lifecycle';

export const REFRESH_COOKIE = 'nivara_refresh';

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
 * narrowed to the one route that consumes it, so ordinary API calls do not
 * carry it at all, and `sameSite: 'lax'` keeps a cross-site request from
 * silently minting a session.
 */
export const refreshCookieOptions = (secure: boolean): CookieOptions => ({
  httpOnly: true,
  secure,
  sameSite: 'lax',
  path: '/auth',
  maxAge: SLIDING_WINDOW_MS,
});

export const setRefreshCookie = (
  response: Response,
  value: string,
  secure: boolean,
): void => {
  response.cookie(REFRESH_COOKIE, value, refreshCookieOptions(secure));
};

/**
 * Clears the cookie on sign-out and on any refusal to refresh.
 *
 * Cleared on refusal too, and deliberately: a client holding a token the
 * server will never accept again would otherwise retry it on a timer forever,
 * and each retry after an eviction looks like fresh theft in the logs.
 */
export const clearRefreshCookie = (
  response: Response,
  secure: boolean,
): void => {
  const options = refreshCookieOptions(secure);

  delete options.maxAge;

  response.clearCookie(REFRESH_COOKIE, options);
};
