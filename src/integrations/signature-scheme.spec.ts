import { createHmac } from 'node:crypto';
import { SignatureScheme, verifySignature } from './signature-scheme';

/**
 * The verifier, driven through a descriptor that is deliberately *not* Slack's.
 *
 * A suite written against Slack's header names and Slack's `v0:` base would pass
 * just as well against a verifier with those constants hard-coded in it — which
 * is exactly the property the ticket asks this module not to have. So the scheme
 * below is invented: different headers, a different prefix, a different signing
 * base, a different window. Slack's own descriptor is checked once, in
 * `slack-signature.spec.ts`, against Slack's published example.
 */
const SCHEME: SignatureScheme = {
  signatureHeader: 'x-acme-signature',
  timestampHeader: 'x-acme-timestamp',
  prefix: 'a1=',
  replayWindowSeconds: 60,
  signingBase: (timestamp, body) => `${timestamp}.${body}`,
};

const SECRET = 'shhh';
const NOW = new Date('2026-07-20T12:00:00.000Z');
const TIMESTAMP = String(Math.floor(NOW.getTime() / 1000));

const sign = (timestamp: string, body: string): string =>
  SCHEME.prefix +
  createHmac('sha256', SECRET)
    .update(SCHEME.signingBase(timestamp, body))
    .digest('hex');

const headersFor = (timestamp: string, body: string) => ({
  'x-acme-timestamp': timestamp,
  'x-acme-signature': sign(timestamp, body),
});

const verify = (
  headers: Record<string, string | undefined>,
  rawBody: string,
  now: Date = NOW,
) => verifySignature(SCHEME, { headers, rawBody, secret: SECRET, now });

describe('verifySignature', () => {
  it('accepts a signature computed over the exact bytes received', () => {
    const body = '{"hello":"world"}';

    expect(verify(headersFor(TIMESTAMP, body), body)).toEqual({ ok: true });
  });

  it('rejects a body that changed after it was signed', () => {
    // The whole point of verifying raw bytes: a payload edited in flight has to
    // fail even though it is still well-formed JSON.
    const headers = headersFor(TIMESTAMP, '{"amount":1}');

    expect(verify(headers, '{"amount":1000}')).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a body that only differs by re-serialization', () => {
    // Semantically identical JSON, different bytes. This is why every port has
    // to preserve the raw body rather than re-encode the parsed object — and it
    // is the failure that would otherwise look like a broken secret.
    const headers = headersFor(TIMESTAMP, '{"a":1,"b":2}');

    expect(verify(headers, '{"b":2,"a":1}')).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('rejects a signature made with another secret', () => {
    const body = '{}';
    const forged =
      SCHEME.prefix +
      createHmac('sha256', 'not-the-secret')
        .update(SCHEME.signingBase(TIMESTAMP, body))
        .digest('hex');

    expect(
      verify(
        { 'x-acme-timestamp': TIMESTAMP, 'x-acme-signature': forged },
        body,
      ),
    ).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a request older than the replay window', () => {
    // A captured request replayed later. The signature is genuine — that is the
    // point — so nothing but the clock can refuse it.
    const body = '{}';
    const old = String(Math.floor(NOW.getTime() / 1000) - 61);

    expect(verify(headersFor(old, body), body)).toEqual({
      ok: false,
      reason: 'stale_timestamp',
    });
  });

  it('rejects a timestamp far enough in the future to widen the window', () => {
    // Symmetric on purpose. A one-sided check would let a captured request with
    // a future timestamp stay replayable for as long as the skew allowed.
    const body = '{}';
    const ahead = String(Math.floor(NOW.getTime() / 1000) + 61);

    expect(verify(headersFor(ahead, body), body)).toEqual({
      ok: false,
      reason: 'stale_timestamp',
    });
  });

  it('accepts a request at the edge of the window', () => {
    const body = '{}';
    const edge = String(Math.floor(NOW.getTime() / 1000) - 60);

    expect(verify(headersFor(edge, body), body)).toEqual({ ok: true });
  });

  it('checks the clock before the signature', () => {
    // Ordering that matters for cost rather than for correctness: a flood of
    // replayed requests is refused by an integer comparison instead of by an
    // HMAC over a body an attacker chose the length of.
    const body = '{}';
    const old = String(Math.floor(NOW.getTime() / 1000) - 3600);

    expect(
      verify(
        { 'x-acme-timestamp': old, 'x-acme-signature': 'a1=garbage' },
        body,
      ),
    ).toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('refuses a missing signature header', () => {
    expect(verify({ 'x-acme-timestamp': TIMESTAMP }, '{}')).toEqual({
      ok: false,
      reason: 'missing_headers',
    });
  });

  it('refuses a missing timestamp header', () => {
    expect(verify({ 'x-acme-signature': 'a1=whatever' }, '{}')).toEqual({
      ok: false,
      reason: 'missing_headers',
    });
  });

  it('refuses a timestamp that is not a number', () => {
    const body = '{}';

    expect(
      verify(
        {
          'x-acme-timestamp': 'yesterday',
          'x-acme-signature': sign('yesterday', body),
        },
        body,
      ),
    ).toEqual({ ok: false, reason: 'missing_headers' });
  });

  it('refuses a signature carrying the wrong prefix', () => {
    // The prefix is a version marker. Accepting an unprefixed digest would mean
    // silently verifying under whatever scheme happened to be current, which is
    // how a downgrade lands.
    const body = '{}';
    const bare = sign(TIMESTAMP, body).slice(SCHEME.prefix.length);

    expect(
      verify({ 'x-acme-timestamp': TIMESTAMP, 'x-acme-signature': bare }, body),
    ).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuses a signature of the wrong length without throwing', () => {
    // `timingSafeEqual` raises on unequal lengths, so a truncated signature is a
    // 500 rather than a 401 unless the length is checked first. Worth a test
    // because an attacker picks that length.
    expect(
      verify(
        { 'x-acme-timestamp': TIMESTAMP, 'x-acme-signature': 'a1=beef' },
        '{}',
      ),
    ).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('reads headers case-insensitively', () => {
    // HTTP header names are case-insensitive, and a descriptor naming
    // `X-Slack-Signature` must not stop matching because a proxy lower-cased it.
    const body = '{}';

    expect(
      verify(
        {
          'X-ACME-TIMESTAMP': TIMESTAMP,
          'X-Acme-Signature': sign(TIMESTAMP, body),
        },
        body,
      ),
    ).toEqual({ ok: true });
  });

  it('verifies a body containing bytes JSON cannot round-trip', () => {
    // Raw bytes means raw bytes. A body with a lone surrogate or invalid UTF-8
    // must still verify or fail on its own terms rather than crashing a parser
    // ahead of the gate.
    const body = '{"note":"café 🍰"}';

    expect(verify(headersFor(TIMESTAMP, body), body)).toEqual({ ok: true });
  });
});
