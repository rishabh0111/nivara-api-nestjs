/**
 * Whether a page may bootstrap this Tenant's widget.
 *
 * The one gate on a public, unauthenticated endpoint, and worth being honest
 * about what it is and is not. It is *not* a credential check: `Origin` is set
 * by the browser and any non-browser caller can send whatever it likes, so this
 * stops nobody with a shell. What it stops is the widget being **lifted** —
 * dropped onto an unrelated site where real visitors' conversations would land
 * in this tenant's queue, and where this tenant's replies would be shown to
 * people who never contacted them. That is a browser-mediated attack, so a
 * browser-mediated defence is the right shape for it.
 *
 * Matching is exact equality after normalization, and every relaxation of that
 * has been considered and refused. Prefix matching admits
 * `https://tenant.example.attacker.test`; suffix matching admits
 * `https://evil.tenant.example`; wildcards invite an entry like `https://*`
 * that turns the allowlist off without looking like it does. A tenant with four
 * subdomains lists four origins, which is a small cost paid by the few tenants
 * who have that problem rather than a sharp edge left out for everyone.
 *
 * Pure, and separate from the service that calls it, because this is the whole
 * security decision of the bootstrap endpoint compressed into one predicate —
 * it should be readable and testable without a database, a request, or a token.
 */
export const originIsAllowed = (
  /** The request's `Origin` header, absent when the caller sent none. */
  origin: string | undefined,
  /** The Tenant's configured origins. Empty means the widget is off. */
  allowed: readonly string[],
): boolean => {
  const candidate = normalizeOrigin(origin);

  if (candidate === null) return false;

  return allowed.some((entry) => normalizeOrigin(entry) === candidate);
};

/**
 * An origin reduced to the form two of them can be compared in, or `null` when
 * there is nothing comparable there.
 *
 * Applied to the configured entries as well as to the header, so a tenant who
 * wrote `https://Example.com/` and a browser that sends `https://example.com`
 * agree. Normalizing only one side is how an allowlist silently stops matching.
 *
 * `null` — the literal string a sandboxed iframe, a `file://` page, or a
 * redirected cross-origin request sends — is refused here rather than compared.
 * It is the opaque origin, meaning "the browser declines to say", and it is
 * exactly what an attacker's context produces. Returning `null` for it means it
 * cannot match even a configured entry that says `"null"`, which is the one
 * case where an operator's mistake would otherwise open the widget to every
 * sandboxed frame on the internet.
 */
const normalizeOrigin = (value: string | undefined): string | null => {
  const trimmed = value?.trim();

  if (!trimmed || trimmed === 'null') return null;

  // Scheme and host are case-insensitive (RFC 6454); the trailing slash is the
  // likeliest way to mistype an entry, and an origin has no path to lose by
  // dropping it. Nothing else is touched — the port is significant, and a
  // default one written out explicitly is left as the operator wrote it.
  return trimmed.toLowerCase().replace(/\/+$/, '');
};
