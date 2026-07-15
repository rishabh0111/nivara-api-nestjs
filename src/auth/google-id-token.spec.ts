import {
  GOOGLE_ISSUERS,
  readIdTokenFromTokenEndpoint,
} from './google-id-token';

/**
 * The claim checks that stand between Google's answer and a session.
 *
 * The signature is deliberately not among them — see the file under test for
 * why — so these *are* the whole verification, which is what makes them worth
 * exercising one at a time rather than through the client that calls them.
 */

const CLIENT_ID = '1234567890-abcdef.apps.googleusercontent.com';

const NOW = new Date('2026-07-20T12:00:00.000Z');

/** Seconds since the epoch, an hour after `NOW`. */
const NOT_YET_EXPIRED = Math.floor(NOW.getTime() / 1000) + 3600;

const encode = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * An ID token in shape only: header, payload, and a signature that is not one.
 *
 * Appropriate because nothing under test reads the signature. A test that
 * produced a genuinely signed token would suggest otherwise, and would quietly
 * stop being honest the day somebody removed a check.
 */
const idTokenFor = (claims: Record<string, unknown>) =>
  `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode(claims)}.not-a-signature`;

const VALID_CLAIMS = {
  iss: 'https://accounts.google.com',
  aud: CLIENT_ID,
  sub: '110169484474386276334',
  email: 'Admin@Meridian.test',
  email_verified: true,
  exp: NOT_YET_EXPIRED,
};

/** The valid claims with one of them left out — an absent claim, not a null one. */
const without = (claim: keyof typeof VALID_CLAIMS): Record<string, unknown> => {
  const claims: Record<string, unknown> = { ...VALID_CLAIMS };
  delete claims[claim];

  return claims;
};

const read = (claims: Record<string, unknown>) =>
  readIdTokenFromTokenEndpoint({
    idToken: idTokenFor(claims),
    clientId: CLIENT_ID,
    now: NOW,
  });

describe('readIdTokenFromTokenEndpoint', () => {
  it('reads the subject and email out of a well-formed token', () => {
    expect(read(VALID_CLAIMS)).toEqual({
      outcome: 'identity',
      identity: {
        subject: '110169484474386276334',
        // Lowercased here rather than at the lookup, because this is the one
        // place that knows the value came from Google. `(tenantId, email)` is
        // stored lowercased, so a mixed-case claim that reached the query
        // unchanged would miss the row and read as "no such User" — a refusal
        // for a person whose account is sitting right there.
        email: 'admin@meridian.test',
      },
    });
  });

  it.each(GOOGLE_ISSUERS)('accepts the issuer %s', (iss) => {
    expect(read({ ...VALID_CLAIMS, iss })).toMatchObject({
      outcome: 'identity',
    });
  });

  /**
   * The check that stops a token minted for somebody else's application being
   * replayed at ours. Without it, any Google client anywhere could hand us an ID
   * token and we would treat its subject as one of this tenant's staff.
   */
  it('refuses a token issued to another client', () => {
    expect(
      read({
        ...VALID_CLAIMS,
        aud: 'someone-elses.apps.googleusercontent.com',
      }),
    ).toEqual({
      outcome: 'refuse',
      reason: 'audience_mismatch',
    });
  });

  it('refuses an issuer that is not Google', () => {
    expect(
      read({ ...VALID_CLAIMS, iss: 'https://accounts.google.com.evil.test' }),
    ).toEqual({
      outcome: 'refuse',
      reason: 'issuer_mismatch',
    });
  });

  /**
   * An unverified address is the whole attack this binding has to survive: the
   * bind is by email, so a Google account claiming an address it has not proved
   * ownership of would be a way to sign in as somebody else's invite.
   */
  it('refuses an unverified email', () => {
    expect(read({ ...VALID_CLAIMS, email_verified: false })).toEqual({
      outcome: 'refuse',
      reason: 'email_unverified',
    });
  });

  it('refuses a token carrying no email at all', () => {
    expect(read(without('email'))).toEqual({
      outcome: 'refuse',
      reason: 'email_unverified',
    });
  });

  it('refuses a token with no subject', () => {
    expect(read(without('sub'))).toEqual({
      outcome: 'refuse',
      reason: 'no_subject',
    });
  });

  it('refuses an expired token', () => {
    expect(
      read({ ...VALID_CLAIMS, exp: Math.floor(NOW.getTime() / 1000) - 1 }),
    ).toEqual({ outcome: 'refuse', reason: 'expired' });
  });

  it.each([
    ['not a JWT at all', 'hello'],
    ['two segments', 'aGk.aGk'],
    ['a payload that is not base64url JSON', 'aGk.!!!.aGk'],
    [
      'a payload that is JSON but not an object',
      `aGk.${encode([] as never)}.aGk`,
    ],
    ['empty', ''],
  ])('refuses %s as malformed', (_case, idToken) => {
    expect(
      readIdTokenFromTokenEndpoint({ idToken, clientId: CLIENT_ID, now: NOW }),
    ).toEqual({ outcome: 'refuse', reason: 'malformed' });
  });
});
