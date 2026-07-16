/**
 * The identifiers documentation is allowed to quote.
 *
 * Every other seeded row takes a freshly generated uuid, which is right for data
 * whose identity nobody outside the database cares about. These few are
 * different: a README that says "GET /tickets/{id}" needs an id that is the same
 * after the next reseed, and a curl snippet whose id died with the last
 * `docker compose down -v` is worse than no snippet — it looks correct and
 * returns 404.
 *
 * So the set is deliberately small. Anchoring everything would be anchoring
 * nothing: the value of a fixed id is that it marks a row somebody committed to
 * writing about, and fifty of them are just uuids typed out longhand.
 *
 * `5eed` spells "seed" in hex, which is the whole reason for the prefix — an id
 * that turns up in a log or a failing test announces where it came from without
 * anybody having to look it up. The second group numbers the kind, the last
 * numbers the row, and the version and variant nibbles (`4`, `8`) are set so
 * these are well-formed UUIDs rather than merely uuid-shaped strings that
 * Postgres happens to accept today.
 */

export const TENANT_IDS = {
  meridian: '5eed0000-0000-4000-8000-000000000001',
  sortwood: '5eed0000-0000-4000-8000-000000000002',
} as const;

/**
 * Every seeded staff member, and the one place the set is larger than "whoever
 * the docs mention".
 *
 * The analytics assignee breakdown is keyed by user id, so a worked example of
 * that endpoint quotes every agent or none of them — anchoring three of four
 * would produce a response half of which cannot be written about.
 */
export const USER_IDS = {
  meridianAdmin: '5eed0001-0000-4000-8000-000000000001',
  meridianAgent: '5eed0001-0000-4000-8000-000000000002',
  meridianAgentTwo: '5eed0001-0000-4000-8000-000000000003',
  meridianAgentThree: '5eed0001-0000-4000-8000-000000000004',
  meridianAgentFour: '5eed0001-0000-4000-8000-000000000005',
  sortwoodAdmin: '5eed0001-0000-4000-8000-000000000006',
  sortwoodAgent: '5eed0001-0000-4000-8000-000000000007',
  /** The shared-address User — `admin` here and `agent` at Meridian, on purpose. */
  sortwoodDual: '5eed0001-0000-4000-8000-000000000008',
} as const;

/** The two Contacts the portal sign-in examples name. */
export const CONTACT_IDS = {
  meridianJules: '5eed0002-0000-4000-8000-000000000001',
  sortwoodSam: '5eed0002-0000-4000-8000-000000000002',
} as const;

/**
 * Meridian's one service token row.
 *
 * The id is fixed; the secret is not, and must not be — see `mintDemoToken`.
 */
export const SERVICE_TOKEN_ID = '5eed0003-0000-4000-8000-000000000001';

/**
 * The five reference Tickets, one per interesting shape.
 *
 * Named for what makes each worth citing rather than for its subject line: the
 * subject can be reworded, but a Ticket stops being the breached example the
 * moment it is answered on time, and the name should fail review when that
 * happens.
 */
export const TICKET_IDS = {
  /** Open, urgent, unassigned, and past its first-response target. */
  breached: '5eed0004-0000-4000-8000-000000000001',
  /** In `pending`, so its resolution clock is stopped and visibly accruing. */
  paused: '5eed0004-0000-4000-8000-000000000002',
  /** Answered by the AI layer and closed with no human on the thread. */
  deflected: '5eed0004-0000-4000-8000-000000000003',
  /** Resolved, reopened, and resolved again — a resumed, not reset, clock. */
  reopened: '5eed0004-0000-4000-8000-000000000004',
  /** Closed, with a linked successor Ticket spawned by a later reply. */
  closedWithSuccessor: '5eed0004-0000-4000-8000-000000000005',
} as const;

/** Meridian's Slack workspace placeholder — data only, no credential. */
export const SLACK_TEAM_ID = 'T5EED000MERIDIAN';

/**
 * The one address the seed deliberately creates in *both* tenants.
 *
 * It lives here rather than in either tenant's file because it belongs to
 * neither: the whole claim is that one address is two Users in two tenants
 * (ADR-0001), and a constant owned by one side would make the isolation tenant
 * import from the showcase to state a fact about itself.
 */
export const SHARED_EMAIL = 'dual@example.test';

/**
 * A stand-in for what Google's `sub` claim looks like, on the shared address in
 * both tenants.
 *
 * Deliberately the *same* value twice, and here for the same reason
 * `SHARED_EMAIL` is: one Google account, two Users, two rows, and a unique index
 * that is per tenant rather than global so both may exist. Two copies of this
 * string in two files would let an edit to one silently delete the claim.
 *
 * Numeric-looking because Google's subjects are. Nothing reads it as a number.
 */
export const SHARED_GOOGLE_SUBJECT = '100000000000000000042';
