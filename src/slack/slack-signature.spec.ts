import { verifySignature } from '../integrations/signature-scheme';
import { SLACK_SIGNATURE_SCHEME } from './slack-signature';

/**
 * Slack's descriptor, checked against Slack's own published example.
 *
 * The verifier has its own suite driven by an invented scheme, so what is left to
 * prove here is exactly one thing: that the constants in the descriptor are the
 * ones Slack actually uses. A test that signed a body with our own descriptor and
 * then verified it would prove only that the file is self-consistent — it would
 * pass with `v1=` and a comma separator, which is the mistake worth catching.
 *
 * The fixture is the example from Slack's "Verifying requests from Slack"
 * documentation, verbatim, including the deliberately expired timestamp.
 */
const SECRET = '8f742231b10e8888abcd99yyyzzz85a5';

const BODY =
  'token=xyzz0WbapA4vBCDEFasx0q6G&team_id=T1DC2JH3J&team_domain=testteamnow&channel_id=G8PSS9T3V&channel_name=foobar&user_id=U2CERLKJA&user_name=roadrunner&command=%2Fwebhook-collect&text=&response_url=https%3A%2F%2Fhooks.slack.com%2Fcommands%2FT1DC2JH3J%2F397700885554%2F96rGlfmibIGlgcZRskXaIFfN&trigger_id=398738663015.47445629121.803a0bc887a14d10d2c447fce8b6703c';

const TIMESTAMP = '1531420618';

const SIGNATURE =
  'v0=a2114d57b48eac39b9ad189dd8316235a7b4a8d21a10bd27519666489c69b503';

/** The instant Slack's example was sent, so the window check is not the subject. */
const SENT_AT = new Date(Number(TIMESTAMP) * 1000);

describe('SLACK_SIGNATURE_SCHEME', () => {
  it('reproduces the signature from Slack’s published example', () => {
    expect(
      verifySignature(SLACK_SIGNATURE_SCHEME, {
        headers: {
          'x-slack-request-timestamp': TIMESTAMP,
          'x-slack-signature': SIGNATURE,
        },
        rawBody: BODY,
        secret: SECRET,
        now: SENT_AT,
      }),
    ).toEqual({ ok: true });
  });

  it('refuses that same example five minutes and a second later', () => {
    // Slack's documented window, asserted at its edge rather than assumed. The
    // example above is otherwise perfectly valid, so nothing but the window can
    // be what refuses it.
    expect(
      verifySignature(SLACK_SIGNATURE_SCHEME, {
        headers: {
          'x-slack-request-timestamp': TIMESTAMP,
          'x-slack-signature': SIGNATURE,
        },
        rawBody: BODY,
        secret: SECRET,
        now: new Date(SENT_AT.getTime() + 301_000),
      }),
    ).toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('names the headers Slack actually sends', () => {
    expect(SLACK_SIGNATURE_SCHEME.signatureHeader).toBe('x-slack-signature');
    expect(SLACK_SIGNATURE_SCHEME.timestampHeader).toBe(
      'x-slack-request-timestamp',
    );
  });

  it('signs `v0:<timestamp>:<body>`', () => {
    expect(SLACK_SIGNATURE_SCHEME.signingBase('123', 'body')).toBe(
      'v0:123:body',
    );
  });
});
