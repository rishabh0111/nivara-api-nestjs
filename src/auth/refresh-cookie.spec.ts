import {
  PORTAL_REFRESH_COOKIE,
  STAFF_REFRESH_COOKIE,
  decodeRefreshCookie,
  encodeRefreshCookie,
  refreshCookieOptions,
} from './refresh-cookie';

const TENANT = '019f74e2-3cea-72cd-ba57-28ff476a61b9';

describe('the refresh cookie value', () => {
  it('round-trips a tenant and a token', () => {
    const token = 'abc123';

    expect(decodeRefreshCookie(encodeRefreshCookie(TENANT, token))).toEqual({
      tenantId: TENANT,
      token,
    });
  });

  /**
   * Tokens are base64url, which has no `.` in its alphabet — but splitting on
   * the *first* separator rather than the only one means a future token format
   * that does contain one still decodes whole rather than silently truncating.
   */
  it('keeps everything after the first separator as the token', () => {
    expect(decodeRefreshCookie(`${TENANT}.a.b.c`)).toEqual({
      tenantId: TENANT,
      token: 'a.b.c',
    });
  });

  it.each([
    ['absent', undefined],
    ['empty', ''],
    ['missing a separator', TENANT],
    ['missing a token', `${TENANT}.`],
    ['missing a tenant', '.sometoken'],
  ])('refuses a cookie that is %s', (_case, value) => {
    expect(decodeRefreshCookie(value)).toBeNull();
  });

  /**
   * The tenant is checked for shape here rather than left to `withTenant()`,
   * which rejects a malformed id by raising rather than refusing — a 500 on a
   * value the client chose. Input a caller controls must not be able to pick
   * the server's error code.
   */
  it.each([
    ['not a uuid at all', 'notauuid.sometoken'],
    ['a uuid missing a group', '019f74e2-3cea-72cd-ba57.sometoken'],
    ['a number', '12345.sometoken'],
  ])('refuses a cookie whose tenant is %s', (_case, value) => {
    expect(decodeRefreshCookie(value)).toBeNull();
  });
});

describe('the refresh cookie flags', () => {
  /**
   * The flags are the security property, not a preference. `httpOnly` is what
   * keeps a page script from lifting the credential; without `path` the cookie
   * would ride along on every API call rather than only the routes that
   * consume it.
   */
  it('is httpOnly, same-site, and scoped to the auth routes', () => {
    expect(refreshCookieOptions(STAFF_REFRESH_COOKIE, false)).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      path: '/auth',
    });
  });

  it('is marked secure in production and not over plain-http development', () => {
    expect(refreshCookieOptions(STAFF_REFRESH_COOKIE, true).secure).toBe(true);
    expect(refreshCookieOptions(STAFF_REFRESH_COOKIE, false).secure).toBe(
      false,
    );
  });

  /**
   * Each surface scopes to the routes that actually serve it.
   *
   * `Path` is matched by prefix, and `/auth` does not prefix `/portal/auth` —
   * so a shared path would mean a browser never sending the portal its own
   * refresh cookie, and portal sessions expiring at fifteen minutes with no
   * refresh and nothing in any log to say why. The names differ so both
   * sessions can coexist in one browser rather than evicting each other.
   */
  it('gives each surface its own name and path', () => {
    expect(STAFF_REFRESH_COOKIE).toEqual({
      name: 'nivara_refresh',
      path: '/auth',
    });

    expect(PORTAL_REFRESH_COOKIE).toEqual({
      name: 'nivara_portal_refresh',
      path: '/portal/auth',
    });

    expect(PORTAL_REFRESH_COOKIE.name).not.toBe(STAFF_REFRESH_COOKIE.name);

    // The portal's path must not be reachable by the staff cookie's scope.
    expect(
      PORTAL_REFRESH_COOKIE.path.startsWith(STAFF_REFRESH_COOKIE.path),
    ).toBe(false);
  });

  it('carries each surface’s own path into the options it builds', () => {
    expect(refreshCookieOptions(PORTAL_REFRESH_COOKIE, false)).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      path: '/portal/auth',
    });
  });
});
