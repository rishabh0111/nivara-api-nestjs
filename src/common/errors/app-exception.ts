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
}
