/**
 * The shape of a widget session token, apart from the signing of it.
 *
 * Separated from the service for the reason `principalFromClaims` is separated
 * from `AccessTokenService`: the claim check is the security boundary, and it
 * should be exercisable without a key, a clock, or a database.
 */

export const WIDGET_TOKEN_ISSUER = 'nivara-desk';

/**
 * A different audience from the staff token's, on top of a different signing
 * key. Redundant by construction — a token signed with the other key fails at
 * the signature and never reaches an audience check — and kept anyway, because
 * the day the two keys are accidentally configured to the same value, this is
 * what still refuses.
 */
export const WIDGET_TOKEN_AUDIENCE = 'nivara-widget';

/**
 * Thirty minutes, renewed silently rather than extended indefinitely.
 *
 * Longer than a staff access token's fifteen because there is no refresh cookie
 * behind it to make expiry cheap, and short enough that a token scraped out of
 * a browser is a narrow window. The row's `expiresAt` is the authority; this is
 * what the JWT's own `exp` is set to so the two agree.
 */
export const WIDGET_SESSION_TTL_SECONDS = 30 * 60;

/**
 * What a widget bearer value is prefixed with.
 *
 * Purely a routing hint, so `AuthGuard` knows which verifier to hand a value to
 * rather than trying every key in the process against it. It grants nothing and
 * proves nothing: stripping it is not authentication, and a staff token wearing
 * this prefix simply fails to verify a moment later. Service tokens are planned
 * to arrive on the same header under `nvk_live_`.
 */
export const WIDGET_TOKEN_PREFIX = 'nvw_';

/**
 * The claims a widget token carries, and deliberately nothing else.
 *
 * Both fields are immutable for the life of the session, which is the rule that
 * decides what may be a claim at all. The resolved Contact, the expiry and the
 * revocation are all mutable, so they live on the `widget_session` row and are
 * read on every request — that is what lets a Contact resolved mid-conversation
 * take effect immediately, and what makes revocation possible at all.
 */
export interface WidgetSessionClaims {
  kind: 'widget';
  /** The `widget_session` row this token names. */
  sub: string;
  tenantId: string;
}

/** What a verified token reduces to, before the row is consulted. */
export interface WidgetSessionRef {
  sessionId: string;
  tenantId: string;
}

export const isWidgetToken = (value: string): boolean =>
  value.startsWith(WIDGET_TOKEN_PREFIX);

export const stripWidgetPrefix = (value: string): string =>
  value.slice(WIDGET_TOKEN_PREFIX.length);

/**
 * Validates the claim shape and reduces it to a session reference, or `null`.
 *
 * `null` for every rejection alike — a missing tenant, a foreign `kind`, a
 * claim set that is not an object — because they are one fact to a caller: no
 * usable session. Distinguishing them in a response would describe the token
 * format to whoever is probing it.
 *
 * The `kind` check is the interesting one, and it is not redundant with the
 * separate signing key even though it looks it. The key means a staff token
 * cannot verify here at all, which is a stronger guarantee — but it is a
 * guarantee about *this* call site holding the right key, and a call site is a
 * thing someone can rewire. This is the claim-level statement of the same rule,
 * and the two would both have to be wrong together.
 */
export const sessionFromClaims = (claims: unknown): WidgetSessionRef | null => {
  if (typeof claims !== 'object' || claims === null) return null;

  const { kind, sub, tenantId } = claims as Record<string, unknown>;

  if (kind !== 'widget') return null;
  if (!isNonEmptyString(sub)) return null;
  if (!isNonEmptyString(tenantId)) return null;

  // Note what is *not* copied out: any `contactId` the token happens to carry.
  // This server does not mint one, so a token bearing it is a forgery attempt —
  // and it resolves to the session it names, with the extra claim never read,
  // rather than to a question about which source of truth wins.
  return { sessionId: sub, tenantId };
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value !== '';
