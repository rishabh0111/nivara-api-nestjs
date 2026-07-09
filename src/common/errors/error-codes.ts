import { HttpStatus } from '@nestjs/common';

/**
 * The closed catalog of machine-readable error codes.
 *
 * `code` — not the HTTP status, not the prose message — is what `nivara-web`
 * and `nivara-ai` branch on, so this catalog is a published contract. It is
 * served verbatim at `GET /meta/error-codes`.
 *
 * Rules:
 * - `snake_case`, stable forever. Renaming a code is a breaking change.
 * - Every code maps to exactly one HTTP status. `code` disambiguates within a
 *   status; the status never disambiguates a code.
 * - Adding a code is a deliberate act that belongs to the ticket introducing
 *   the failure mode. Nothing throws an uncatalogued code — `AppException`
 *   only accepts keys of this map.
 */
export const ERROR_CATALOG = {
  // --- Request shape (400) -------------------------------------------------
  malformed_request: {
    status: HttpStatus.BAD_REQUEST,
    description: 'The request could not be parsed or is structurally invalid.',
  },
  invalid_filter: {
    status: HttpStatus.BAD_REQUEST,
    description:
      'An unknown query parameter was supplied, or a filter value is outside the allowed set for this resource. Unknown parameters are rejected rather than ignored.',
  },
  invalid_sort: {
    status: HttpStatus.BAD_REQUEST,
    description:
      'The requested sort field is not sortable on this resource. Use `field` for ascending, `-field` for descending.',
  },
  invalid_cursor: {
    status: HttpStatus.BAD_REQUEST,
    description:
      'The pagination cursor is malformed or was issued for a different sort. Restart the traversal without a cursor.',
  },

  // --- Authentication and authorization (401 / 403) ------------------------
  unauthenticated: {
    status: HttpStatus.UNAUTHORIZED,
    description:
      'No credential was presented, or the credential is invalid or expired.',
  },
  forbidden: {
    status: HttpStatus.FORBIDDEN,
    description:
      'The principal is authenticated but lacks the permission this operation requires.',
  },

  // --- Existence (404) -----------------------------------------------------
  not_found: {
    status: HttpStatus.NOT_FOUND,
    description:
      'No such resource is visible to this principal. A record belonging to another tenant is indistinguishable from one that does not exist.',
  },

  // --- Conflict and validation (409 / 422) ---------------------------------
  conflict: {
    status: HttpStatus.CONFLICT,
    description:
      'The request conflicts with the current state of the resource.',
  },
  idempotency_in_flight: {
    status: HttpStatus.CONFLICT,
    description:
      'An earlier request carrying this `Idempotency-Key` has not finished yet, so there is no response to replay. Retry after a short delay; the original is still running and its effect will happen exactly once. Distinct from `conflict`, which is about the resource rather than the retry.',
  },
  validation_failed: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description:
      'The request body failed validation. `details` enumerates one entry per offending field.',
  },
  idempotency_key_reused: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    description:
      'This `Idempotency-Key` was already used for a different request. A key identifies one request, not one caller — reusing it with a changed body is refused rather than answered from the earlier request’s cached response, which would report success for an operation that never ran.',
  },

  // --- Throttling (429) ----------------------------------------------------
  rate_limited: {
    status: HttpStatus.TOO_MANY_REQUESTS,
    description:
      'The per-principal rate limit was exceeded. Retry after the interval given in the `Retry-After` header.',
  },

  // --- Server (500) --------------------------------------------------------
  internal_error: {
    status: HttpStatus.INTERNAL_SERVER_ERROR,
    description: 'An unexpected server error occurred.',
  },
} as const satisfies Record<
  string,
  { status: HttpStatus; description: string }
>;

export type ErrorCode = keyof typeof ERROR_CATALOG;

export const ERROR_CODES = Object.keys(ERROR_CATALOG) as ErrorCode[];

export const statusForCode = (code: ErrorCode): HttpStatus =>
  ERROR_CATALOG[code].status;
