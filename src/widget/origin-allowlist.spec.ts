import { originIsAllowed } from './origin-allowlist';

/**
 * The rule that decides whether the widget may be bootstrapped from a page.
 *
 * Every case below is really the same claim from a different angle: matching is
 * *exact*, and every near-miss is a miss. That matters more than it looks,
 * because the failures here are silent in the direction that hurts — an
 * allowlist that is too generous does not error, it just serves a session to
 * somewhere it should not have.
 */
describe('originIsAllowed', () => {
  const ALLOWED = ['https://meridian.example', 'http://localhost:3000'];

  it('admits an exact match', () => {
    expect(originIsAllowed('https://meridian.example', ALLOWED)).toBe(true);
    expect(originIsAllowed('http://localhost:3000', ALLOWED)).toBe(true);
  });

  it('refuses an origin that is not on the list', () => {
    expect(originIsAllowed('https://attacker.example', ALLOWED)).toBe(false);
  });

  /**
   * The lift attack in its plainest form: a page that embeds the tenant's own
   * origin as a *prefix* of its own. A `startsWith` implementation admits this,
   * which is exactly why the check is equality.
   */
  it('refuses an origin that merely starts with an allowed one', () => {
    expect(
      originIsAllowed('https://meridian.example.attacker.test', ALLOWED),
    ).toBe(false);
  });

  /** And the same trick from the other end, against a suffix match. */
  it('refuses a subdomain of an allowed origin', () => {
    expect(originIsAllowed('https://evil.meridian.example', ALLOWED)).toBe(
      false,
    );
  });

  /**
   * Scheme is part of the origin and is not negotiable. An `http://` page
   * bootstrapping against an `https://` allowlist entry is a downgrade, and
   * the session token would travel in clear.
   */
  it('refuses a matching host on the wrong scheme', () => {
    expect(originIsAllowed('http://meridian.example', ALLOWED)).toBe(false);
  });

  /** Port is part of the origin too — a different port is a different app. */
  it('refuses a matching host on the wrong port', () => {
    expect(originIsAllowed('http://localhost:4000', ALLOWED)).toBe(false);
  });

  /**
   * Scheme and host are case-insensitive per RFC 6454, and browsers normalize
   * them before sending — but a hand-written allowlist entry may not be
   * normalized, and that mismatch would refuse a legitimate site for a reason
   * nobody could see in a log.
   */
  it('ignores case in the scheme and host', () => {
    expect(originIsAllowed('HTTPS://Meridian.Example', ALLOWED)).toBe(true);
  });

  /**
   * A trailing slash makes it a URL rather than an origin. Tolerated on the
   * configured side because it is the single most likely way to mistype an
   * entry, and refusing it would look like the allowlist simply not working.
   */
  it('tolerates a trailing slash on a configured entry', () => {
    expect(
      originIsAllowed('https://meridian.example', [
        'https://meridian.example/',
      ]),
    ).toBe(true);
  });

  /**
   * An empty allowlist means the widget is off for this tenant, and "off" has
   * to be the state a Tenant nobody configured is in — the endpoint is public,
   * so the default cannot be "any page may mint a session".
   */
  it('refuses everything when nothing is allowlisted', () => {
    expect(originIsAllowed('https://meridian.example', [])).toBe(false);
  });

  /**
   * A caller that sent no `Origin` at all — a non-browser client, or a request
   * forged outside one. There is nothing to compare, and "nothing" must not
   * compare equal to an unconfigured entry.
   */
  it('refuses a request that presented no origin', () => {
    expect(originIsAllowed(undefined, ALLOWED)).toBe(false);
    expect(originIsAllowed('', ALLOWED)).toBe(false);
  });

  /**
   * `null` is a real `Origin` value, sent by a sandboxed iframe, a `file://`
   * page, or a redirected cross-origin request. It is precisely the value an
   * attacker's context produces, and it must never match — including against a
   * literal `"null"` somebody put on the list by accident.
   */
  it('refuses the opaque `null` origin', () => {
    expect(originIsAllowed('null', ALLOWED)).toBe(false);
    expect(originIsAllowed('null', ['null'])).toBe(false);
  });
});
