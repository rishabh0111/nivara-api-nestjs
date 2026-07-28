import { browserCorsPolicy } from './browser-cors';

/**
 * Which browser callers get what.
 *
 * The single property worth defending here is that `credentials` is granted to
 * a named origin and to nothing else. Everything else in this policy is a
 * convenience; that one line is what stands between the refresh cookie and any
 * page on the internet, and it fails in the quiet direction — a policy that is
 * too generous does not error, it just answers.
 */
describe('browserCorsPolicy', () => {
  const FIRST_PARTY = [
    'https://nivara-web.vercel.app',
    'http://localhost:3000',
  ];

  it('grants credentials to a first-party origin', () => {
    expect(
      browserCorsPolicy('https://nivara-web.vercel.app', FIRST_PARTY),
    ).toMatchObject({ origin: true, credentials: true });
  });

  /**
   * The widget's case, and the reason this is a per-request decision at all: an
   * origin nobody configured is still answered, because the tenant's own
   * allowlist is checked inside the bootstrap endpoint where the `tenantId` is
   * readable. What it is not given is credentials.
   */
  it('answers an unknown origin without credentials', () => {
    expect(
      browserCorsPolicy('https://a-tenants-own-site.example', FIRST_PARTY),
    ).toMatchObject({ origin: true, credentials: false });
  });

  /**
   * The near-miss cases are inherited from `originIsAllowed` rather than
   * reimplemented, and are asserted here because the consequence is different:
   * over there a near-miss costs a widget session, here it would cost the
   * cookie.
   */
  it.each([
    ['a prefix of one', 'https://nivara-web.vercel.app.attacker.test'],
    ['a subdomain of one', 'https://evil.nivara-web.vercel.app'],
    ['the opaque origin', 'null'],
  ])('refuses credentials to %s', (_case, origin) => {
    expect(browserCorsPolicy(origin, FIRST_PARTY)).toMatchObject({
      credentials: false,
    });
  });

  /** No `Origin` is no browser, and there is nobody to grant anything to. */
  it('emits no CORS headers when the caller sent no origin', () => {
    expect(browserCorsPolicy(undefined, FIRST_PARTY)).toEqual({
      origin: false,
    });
  });

  /**
   * A 429 whose `Retry-After` a browser cannot read is a 429 a client can only
   * answer by guessing, which is how backoff becomes a retry storm.
   */
  it('exposes the headers a correct client has to act on', () => {
    const policy = browserCorsPolicy('https://anywhere.example', FIRST_PARTY);

    expect(policy.exposedHeaders).toEqual(
      expect.arrayContaining([
        'Retry-After',
        'RateLimit-Remaining',
        'Idempotency-Replayed',
      ]),
    );
  });

  /** An empty list is the "no front end configured" case, not an open door. */
  it('grants credentials to nobody when no first-party origin is configured', () => {
    expect(
      browserCorsPolicy('https://nivara-web.vercel.app', []),
    ).toMatchObject({ credentials: false });
  });
});
