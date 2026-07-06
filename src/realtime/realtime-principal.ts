import {
  ContactPrincipal,
  RequestPrincipal,
  StaffPrincipal,
  WidgetPrincipal,
} from '../auth/request-principal';

/**
 * Who may hold a socket — a narrowing of `RequestPrincipal`, not a new union.
 *
 * Three of the four request principals, and the omission is the interesting
 * part. A `ServicePrincipal` is refused at the handshake because there is no
 * question this surface could answer for it: a service token's authority is a
 * set of scopes chosen one integration at a time, and the room gate below reads
 * *staff versus customer*, which is not a scope. Admitting one would mean
 * inventing a scope-to-room mapping now, on behalf of no caller, and getting it
 * wrong in the direction that matters — a machine caller sitting in an
 * `:internal` room.
 *
 * A signed-in Contact is admitted alongside the widget visitor the ticket names,
 * because the two are the same principal wearing different credentials: the
 * portal exchanges a password for a `contact` token, the widget exchanges an
 * origin for a session, and both end up as "the party who requested this
 * Ticket". Refusing the portal one would have meant a Contact seeing replies in
 * the widget and not on the surface they actually signed into.
 */
export type RealtimePrincipal =
  StaffPrincipal | ContactPrincipal | WidgetPrincipal;

/**
 * The socket's answer to "is this the staff axis or the customer axis?".
 *
 * Every authority question on this surface reduces to this one, which is why it
 * is a function rather than three inline `kind ===` checks: `:agents` and
 * `:internal` are staff-only, notes are staff-only, and the day a fourth
 * principal kind can hold a socket, it is answered here once instead of in each
 * of those places separately.
 *
 * Note it asks about the *kind*, not about a role or a permission. An `agent`
 * and an `admin` see the same rooms — the distinction between them is about what
 * they may change, and a socket changes nothing.
 */
export const isStaff = (principal: RealtimePrincipal): boolean =>
  principal.kind === 'user';

/**
 * A request principal admitted to the socket, or `null` for one that is not.
 *
 * The single place the omission above is enforced, so `AuthGuard` and this
 * surface cannot drift into disagreeing about who exists: the credential
 * verifiers stay shared and whole, and the narrowing happens once, here, on
 * their output.
 */
export const realtimePrincipalOf = (
  principal: RequestPrincipal,
): RealtimePrincipal | null =>
  principal.kind === 'service' ? null : principal;
