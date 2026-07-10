import { SignatureScheme } from '../integrations/signature-scheme';

/**
 * How Slack signs a request, as data.
 *
 * The whole of this adapter's crypto, and it is a constant rather than code
 * because the verifier is general over the descriptor — which is the property
 * ticket 17 asks for by name. A second source is a second object beside this one;
 * no branch in the verifier learns about it, and nothing here is reachable from a
 * place that could get the algorithm wrong.
 *
 * The values come from Slack's "Verifying requests from Slack" documentation and
 * are checked against the worked example there in the spec beside this file. That
 * is the only way to know a constant is right: signing something with these
 * numbers and then verifying it with the same numbers proves the file agrees with
 * itself and nothing more.
 */
export const SLACK_SIGNATURE_SCHEME: SignatureScheme = {
  signatureHeader: 'x-slack-signature',
  timestampHeader: 'x-slack-request-timestamp',

  // The version marker Slack puts in front of the digest. Compared rather than
  // stripped: if Slack ever ships a `v1`, a verifier that ignored the prefix
  // would keep validating `v0` digests against a `v1` scheme forever.
  prefix: 'v0=',

  // Slack's own documented tolerance. Five minutes is generous for a request
  // that travels once, and it is the number Slack's retries are built around, so
  // narrowing it would refuse redeliveries the provider considers timely.
  replayWindowSeconds: 300,

  // `v0:<timestamp>:<raw body>`. The version appears here as well as in the
  // prefix, and that is Slack's design rather than redundancy on our part: it
  // binds the digest to the scheme that produced it, so a signature cannot be
  // lifted from one version to another.
  signingBase: (timestamp, rawBody) => `v0:${timestamp}:${rawBody}`,
};
