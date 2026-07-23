import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * How one inbound source proves a request came from it.
 *
 * A descriptor rather than a Slack-shaped function, and the reason is written
 * into the Slack channel's design as a requirement: a second source must be
 * *configuration* here
 * rather than new crypto code. Every provider's scheme is the same three moves —
 * take a timestamp and the raw bytes, build a string from them, HMAC it under a
 * shared secret — and they differ only in the header names, the separator, the
 * prefix and the window. Those differences are data, so they are data.
 *
 * Note what the descriptor deliberately does not carry: the secret. Resolving one
 * may need a database read, a tenant, or a KMS call, and folding that in would
 * make this type unconstructable as a constant and untestable without a
 * container. The caller resolves it and passes it in.
 *
 * The algorithm is not a field either. It is HMAC-SHA256, and making it
 * configurable would mean this module accepting whatever a descriptor named —
 * including, eventually, something weak. A source that needs another algorithm is
 * a change to this file, made deliberately, with the old one still refusing.
 */
export interface SignatureScheme {
  /** The header carrying the signature, matched case-insensitively. */
  signatureHeader: string;

  /** The header carrying the request's instant, as whole seconds since the epoch. */
  timestampHeader: string;

  /**
   * The version marker the signature is expected to begin with (`v0=` for
   * Slack). Compared rather than stripped-and-ignored: accepting an unprefixed
   * digest would mean verifying under whichever scheme happened to be current,
   * which is how a downgrade lands.
   */
  prefix: string;

  /** How far from now a request's timestamp may be, in seconds, in either direction. */
  replayWindowSeconds: number;

  /**
   * The exact string that gets signed, built from the timestamp and the raw
   * body. Slack's is `v0:${ts}:${body}`; the shape varies per provider and is the
   * main thing this descriptor exists to vary.
   */
  signingBase: (timestamp: string, rawBody: string) => string;
}

/** Everything one verification needs, and nothing about HTTP beyond the headers. */
export interface SignatureCheck {
  headers: Record<string, string | string[] | undefined>;

  /**
   * The body exactly as it arrived, before any parsing.
   *
   * The single most important input here. A re-serialized parsed object has the
   * same meaning and different bytes, so it produces a different digest — which
   * surfaces as a signature that never matches and looks for all the world like
   * a wrong secret. Every port has to preserve these bytes.
   */
  rawBody: string;

  secret: string;

  now: Date;
}

/**
 * Why a request was refused, for the log and never for the response.
 *
 * The caller answers all three identically — a bare 401 — because a client able
 * to tell "your signature is wrong" from "your clock is off" learns which half of
 * the scheme to keep probing. The distinction is kept anyway, because the person
 * reading the log at three in the morning is not the attacker and the two
 * failures have completely different remedies.
 */
export type SignatureFailure =
  /** A header was absent, or the timestamp was not a number. */
  | 'missing_headers'
  /** Genuine or not, the request is outside the replay window. */
  | 'stale_timestamp'
  /** The digest did not match, or did not carry the expected prefix. */
  | 'bad_signature';

export type SignatureResult =
  { ok: true } | { ok: false; reason: SignatureFailure };

/**
 * Whether this request was signed by the holder of this secret, recently.
 *
 * Both halves matter and neither is sufficient. A valid signature on an old
 * request is a captured request being replayed; a fresh timestamp with a bad
 * signature is a forgery. So the two checks are conjunctive, and this returns a
 * result rather than throwing — the caller has to answer the same 401 for every
 * failure, and an exception per reason would be three ways to spell one response.
 *
 * The clock is checked *first*, and that ordering is about cost rather than
 * correctness: a flood of replayed requests is then refused by an integer
 * comparison instead of by an HMAC over a body whose length the attacker chose.
 *
 * The comparison is constant-time. A byte-by-byte `===` on a hex digest leaks how
 * many leading bytes were right through how long the comparison took, which is
 * enough to recover a signature one byte at a time given enough attempts — and an
 * endpoint a provider retries is an endpoint that tolerates a great many
 * attempts. Lengths are checked before `timingSafeEqual`, which raises on
 * mismatched ones; an attacker picks that length, so an unchecked call is a 500
 * they can trigger at will.
 */
export const verifySignature = (
  scheme: SignatureScheme,
  { headers, rawBody, secret, now }: SignatureCheck,
): SignatureResult => {
  const signature = headerValue(headers, scheme.signatureHeader);
  const timestamp = headerValue(headers, scheme.timestampHeader);

  if (!signature || !timestamp) return refuse('missing_headers');

  // Whole seconds since the epoch, and validated as such rather than trusted:
  // `Number('yesterday')` is `NaN`, and every comparison against `NaN` is false —
  // so an unparsed value would sail through the window check below rather than
  // failing it.
  const sentAt = Number(timestamp);

  if (!Number.isFinite(sentAt)) return refuse('missing_headers');

  const skewSeconds = Math.abs(now.getTime() / 1000 - sentAt);

  // Symmetric. A one-sided check — refusing only the past — would leave a
  // captured request bearing a future timestamp replayable for as long as that
  // timestamp stayed ahead of the clock.
  if (skewSeconds > scheme.replayWindowSeconds)
    return refuse('stale_timestamp');

  const expected = Buffer.from(
    scheme.prefix +
      createHmac('sha256', secret)
        .update(scheme.signingBase(timestamp, rawBody))
        .digest('hex'),
  );
  const presented = Buffer.from(signature);

  if (expected.length !== presented.length) return refuse('bad_signature');

  return timingSafeEqual(expected, presented)
    ? { ok: true }
    : refuse('bad_signature');
};

const refuse = (reason: SignatureFailure): SignatureResult => ({
  ok: false,
  reason,
});

/**
 * One header, matched without regard to case and collapsed to a single value.
 *
 * HTTP header names are case-insensitive, so a descriptor spelling
 * `X-Slack-Signature` must keep working behind a proxy that lower-cased it.
 * Repeated headers arrive as an array, and a signature sent twice is refused
 * rather than resolved to the first: two values means somebody is trying
 * something, and picking one would be picking which.
 */
const headerValue = (
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined => {
  const wanted = name.toLowerCase();

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;

    return typeof value === 'string' ? value : undefined;
  }

  return undefined;
};
