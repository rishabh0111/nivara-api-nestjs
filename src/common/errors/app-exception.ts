import { ErrorCode, statusForCode } from './error-codes';

/** One entry per offending field. Present only on `validation_failed` (422). */
export interface ErrorDetail {
  field: string;
  issue: string;
}

/**
 * The single error type the application throws.
 *
 * Every failure that reaches a client goes through here, which is what lets one
 * exception filter produce one envelope shape. The HTTP status is derived from
 * the catalog rather than passed in, so a code cannot drift across two statuses
 * at two throw sites.
 */
export class AppException extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: ErrorDetail[];

  constructor(code: ErrorCode, message: string, details?: ErrorDetail[]) {
    super(message);
    this.name = 'AppException';
    this.code = code;
    this.status = statusForCode(code);
    this.details = details;
  }

  /**
   * A record the caller may not see — because it does not exist, or because RLS
   * makes another tenant's row invisible. Both answer 404, never 403: a 403
   * would confirm the row exists and open a tenancy-probing side channel.
   */
  static notFound(resource: string): AppException {
    return new AppException('not_found', `No such ${resource}.`);
  }

  /**
   * One refusal for every authorization failure, deliberately.
   *
   * A caller learning *which* permission they lack learns the shape of the
   * tenant's authority model, and a caller able to tell "you may not" from
   * "this endpoint is misconfigured" learns where to keep probing. Neither is
   * actionable to a legitimate client: both mean ask an admin.
   *
   * Here rather than in the guard because the guard is not the only place
   * authority is decided — an operation whose permission depends on the row it
   * touches, like closing a Ticket, has to check in the service — and a second
   * refusal message would be a side channel the guard's care did not close.
   */
  static forbidden(): AppException {
    return new AppException(
      'forbidden',
      'This operation requires a permission your role does not hold.',
    );
  }
}
