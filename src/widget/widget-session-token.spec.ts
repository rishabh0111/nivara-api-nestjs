import {
  WIDGET_TOKEN_PREFIX,
  isWidgetToken,
  sessionFromClaims,
  stripWidgetPrefix,
} from './widget-session-token';

const SESSION = '018f2a00-0000-7000-8000-000000000001';
const TENANT = '018f2a00-0000-7000-8000-0000000000aa';

const VALID = { kind: 'widget', sub: SESSION, tenantId: TENANT };

/**
 * What a validly-signed widget token is still not allowed to say.
 *
 * A signature proves this server minted the token; it proves nothing about
 * which claims this version of the code expects to find, and `tenantId` is too
 * load-bearing to take on trust — it is what arms row-level security. Every
 * rejection below is the same answer as every other, because telling a caller
 * *which* claim displeased the server describes the token format to whoever is
 * probing it.
 */
describe('sessionFromClaims', () => {
  it('reduces a well-formed claim set to a session', () => {
    expect(sessionFromClaims(VALID)).toEqual({
      sessionId: SESSION,
      tenantId: TENANT,
    });
  });

  it('refuses claims with no tenant, which would arm no context at all', () => {
    expect(sessionFromClaims({ kind: 'widget', sub: SESSION })).toBeNull();
  });

  it('refuses claims with no subject, which name no session row', () => {
    expect(sessionFromClaims({ kind: 'widget', tenantId: TENANT })).toBeNull();
  });

  /**
   * The claim that says what the bearer is. A separate signing key already
   * means a staff token cannot reach this function — but "cannot reach" is a
   * fact about one call site, and the kind check is the statement that survives
   * someone wiring a second one.
   */
  it('refuses a token minted for another surface', () => {
    expect(sessionFromClaims({ ...VALID, kind: 'user' })).toBeNull();
    expect(sessionFromClaims({ ...VALID, kind: 'contact' })).toBeNull();
  });

  /** Absent, rather than wrong. Neither may be defaulted to `widget`. */
  it('refuses claims that do not say what they are', () => {
    expect(sessionFromClaims({ sub: SESSION, tenantId: TENANT })).toBeNull();
  });

  /**
   * A resolved Contact is deliberately *not* a claim. It lives on the session
   * row, so it can change mid-conversation without re-minting — and so a token
   * cannot assert a Contact the server never wrote. A token carrying one is
   * something this server does not mint, which is what a forgery looks like;
   * it resolves to the session it names and the extra claim is ignored, never
   * read.
   */
  it('ignores a contact claim rather than believing it', () => {
    expect(sessionFromClaims({ ...VALID, contactId: 'somebody-else' })).toEqual(
      {
        sessionId: SESSION,
        tenantId: TENANT,
      },
    );
  });

  it('refuses anything that is not a claim object', () => {
    expect(sessionFromClaims(null)).toBeNull();
    expect(sessionFromClaims('a string')).toBeNull();
    expect(sessionFromClaims(undefined)).toBeNull();
  });
});

/**
 * The prefix is a routing hint and nothing more. It decides which verifier a
 * bearer value is handed to, so that one credential type is not tried against
 * every key in the process — it is not itself a check, and stripping it grants
 * nothing.
 */
describe('the widget token prefix', () => {
  it('recognizes a widget token', () => {
    expect(isWidgetToken(`${WIDGET_TOKEN_PREFIX}abc.def.ghi`)).toBe(true);
  });

  it('does not claim a staff token', () => {
    expect(isWidgetToken('eyJhbGciOiJIUzI1NiJ9.abc.def')).toBe(false);
  });

  it('strips the prefix to leave the signed value', () => {
    expect(stripWidgetPrefix(`${WIDGET_TOKEN_PREFIX}abc.def.ghi`)).toBe(
      'abc.def.ghi',
    );
  });
});
