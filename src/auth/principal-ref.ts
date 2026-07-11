import { RequestPrincipal } from './request-principal';

/**
 * A stable, server-side reference to whoever is making a request.
 *
 * Prefixed by kind, so a User and a Contact whose ids happened to collide are
 * still two callers. Every input is server-determined — the principal comes
 * from a validated credential — so nothing a client sends can steer which
 * reference it is given, which is the property both consumers rest on.
 *
 * A widget visitor is keyed on the *session* rather than on the Contact behind
 * it, and that is the one genuinely considered choice here: a visitor's first
 * write is what creates their Contact, so the Contact is null on the original
 * request and present on the retry. The session is the identity that spans
 * both, which is what a widget session is for. Idempotency needs that because
 * keying on the Contact would put a retry in a different partition and let it
 * open a second Ticket; rate limiting needs it because a per-request identity
 * is a budget that resets per request.
 *
 * Shared by the idempotency scope and the rate-limit key rather than written
 * twice. Both are asking the same question — "which caller is this, in a form
 * safe to put in a key" — and two answers that drifted would mean a principal
 * that is one caller to one subsystem and two to the other.
 */
export const principalRef = (principal: RequestPrincipal): string => {
  switch (principal.kind) {
    case 'user':
      return `u:${principal.userId}`;
    case 'contact':
      return `c:${principal.contactId}`;
    case 'widget':
      return `w:${principal.sessionId}`;
    case 'service':
      return `s:${principal.tokenId}`;
  }
};
