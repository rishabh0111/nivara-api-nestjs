/**
 * A person, as Google is willing to vouch for them.
 *
 * Two fields, and no more, because two is all the binding needs: `subject` is
 * who this is, `email` is which invite-provisioned User that resolves to. A name
 * or a picture would be a profile, and Google is not the source of truth for a
 * User's profile here — the invite is.
 */
export interface GoogleIdentity {
  /**
   * Google's `sub`. Stable for one person at one Google account and never
   * reassigned, which is why a returning sign-in matches on it rather than on
   * the email — an address can be changed or transferred, a subject cannot.
   */
  subject: string;

  /** Lowercased, because `(tenantId, email)` is stored and compared lowercased. */
  email: string;
}

/**
 * The two forms Google issues `iss` in. Both are current — Google has never
 * settled on one — so accepting only the scheme-qualified spelling would refuse
 * perfectly good tokens intermittently, which is the worst kind of auth bug.
 */
export const GOOGLE_ISSUERS = [
  'https://accounts.google.com',
  'accounts.google.com',
] as const;

/** Why a token was not turned into an identity. Logged, never returned to a caller. */
export type IdTokenRefusal =
  | 'malformed'
  | 'issuer_mismatch'
  | 'audience_mismatch'
  | 'no_subject'
  | 'email_unverified'
  | 'expired';

export type IdTokenOutcome =
  | { outcome: 'identity'; identity: GoogleIdentity }
  | { outcome: 'refuse'; reason: IdTokenRefusal };

/** Only the claims this binding reads. Everything else Google sends is ignored. */
interface IdTokenClaims {
  iss?: unknown;
  aud?: unknown;
  sub?: unknown;
  email?: unknown;
  email_verified?: unknown;
  exp?: unknown;
}

const refuse = (reason: IdTokenRefusal): IdTokenOutcome => ({
  outcome: 'refuse',
  reason,
});

/**
 * Reads the claims out of an ID token that came back from Google's token
 * endpoint.
 *
 * **This does not verify the signature, and the name is the guard rail.** It is
 * safe here and nowhere else: in the authorization-code flow the token arrives
 * in the body of a TLS request this server made directly to
 * `oauth2.googleapis.com`, authenticated with the client secret. The channel is
 * the proof — nobody else can answer that request — which is exactly the case
 * OIDC Core §3.1.3.7 excuses signature validation for.
 *
 * The claim that would make this unsafe is "an ID token supplied by a client".
 * Such a token has proved nothing about its channel and *must* be checked
 * against Google's JWKS. If this API ever grows that endpoint, it needs a
 * different function, not a new call site for this one.
 *
 * Pure, and returns a reason rather than throwing, so that the client above it
 * can log which check failed while telling the caller only that sign-in was
 * refused. Every distinction the response could draw is a fact about who holds
 * an account here.
 */
export const readIdTokenFromTokenEndpoint = (input: {
  idToken: string;
  clientId: string;
  now: Date;
}): IdTokenOutcome => {
  const claims = decodePayload(input.idToken);

  if (!claims) return refuse('malformed');

  // Issuer before audience, and both before anything is read as an identity. A
  // token minted by another issuer, or for another application, is not a weaker
  // credential — it is somebody else's credential, and reading a subject out of
  // it would be reading a stranger's.
  if (
    typeof claims.iss !== 'string' ||
    !(GOOGLE_ISSUERS as readonly string[]).includes(claims.iss)
  ) {
    return refuse('issuer_mismatch');
  }

  if (claims.aud !== input.clientId) return refuse('audience_mismatch');

  if (
    typeof claims.exp !== 'number' ||
    claims.exp * 1000 <= input.now.getTime()
  ) {
    return refuse('expired');
  }

  if (typeof claims.sub !== 'string' || claims.sub.length === 0) {
    return refuse('no_subject');
  }

  // The address and its verification are one check, deliberately. The binding is
  // by email, so an unverified address is a claim to be somebody rather than
  // evidence of it — and a Google account can be created against an address its
  // holder never proved they own. Treating a missing email as unverified is the
  // same fact stated once: there is no address this token has proved.
  if (
    claims.email_verified !== true ||
    typeof claims.email !== 'string' ||
    claims.email.length === 0
  ) {
    return refuse('email_unverified');
  }

  return {
    outcome: 'identity',
    identity: { subject: claims.sub, email: claims.email.toLowerCase() },
  };
};

/** The middle segment, or `null` if the value is not a JWT-shaped string at all. */
const decodePayload = (idToken: string): IdTokenClaims | null => {
  const segments = idToken.split('.');

  if (segments.length !== 3) return null;

  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(segments[1], 'base64url').toString('utf8'),
    );

    // Arrays and nulls parse happily and would then read every claim as
    // `undefined` — which lands on `issuer_mismatch`, a refusal that reads as a
    // token from the wrong issuer rather than as one that is not a token.
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
};
