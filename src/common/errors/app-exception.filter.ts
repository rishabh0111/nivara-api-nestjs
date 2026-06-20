import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AppException, ErrorDetail } from './app-exception';
import { ErrorCode, statusForCode } from './error-codes';

interface ErrorEnvelope {
  error: { code: ErrorCode; message: string; details?: ErrorDetail[] };
}

/**
 * The single place an exception becomes a response body.
 *
 * Every non-2xx leaves through here, which is what makes the envelope uniform
 * without any controller writing error-shaping code. Exceptions raised by the
 * framework itself — an unmatched route, a payload too large — are normalised
 * into the same catalog rather than escaping in Nest's default shape.
 */
@Catch()
export class AppExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(AppExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request>();

    const { status, envelope } = this.normalise(exception, request);

    response.status(status).json(envelope);
  }

  private normalise(
    exception: unknown,
    request: Request,
  ): { status: number; envelope: ErrorEnvelope } {
    if (exception instanceof AppException) {
      return {
        status: exception.status,
        envelope: {
          error: {
            code: exception.code,
            message: exception.message,
            ...(exception.details ? { details: exception.details } : {}),
          },
        },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();

      return {
        status,
        envelope: {
          error: {
            code: codeForStatus(status),
            message: messageOf(exception),
          },
        },
      };
    }

    // Anything else is a bug. Log it with its stack for the operator; tell the
    // client nothing beyond the fact that it failed.
    this.logger.error(
      `Unhandled exception on ${request.method} ${request.url}`,
      exception instanceof Error ? exception.stack : String(exception),
    );

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      envelope: {
        error: {
          code: 'internal_error',
          message: 'An unexpected error occurred.',
        },
      },
    };
  }
}

/**
 * The catalog code to report when an exception carries only an HTTP status —
 * a framework-raised error such as an unmatched route.
 *
 * Every code here is the general one for its status; codes that narrow a status
 * (`invalid_filter` narrowing 400, say) are only ever thrown deliberately, so
 * they must not be inferred from a status alone.
 */
const GENERAL_CODES = [
  'malformed_request',
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict',
  'validation_failed',
  'rate_limited',
  'internal_error',
] as const satisfies readonly ErrorCode[];

// Derived from the catalog rather than hand-written, so the status a code maps
// to is stated in exactly one place and the two cannot drift apart.
const CODE_BY_STATUS = new Map<number, ErrorCode>(
  GENERAL_CODES.map((code) => [statusForCode(code), code]),
);

const codeForStatus = (status: number): ErrorCode =>
  CODE_BY_STATUS.get(status) ?? 'internal_error';

/**
 * Nest packs its own exception messages into a `{ statusCode, message, error }`
 * object. Unwrap the prose and drop the rest — `statusCode` duplicates the HTTP
 * status and `error` is a status name, neither of which belongs in the envelope.
 */
const messageOf = (exception: HttpException): string => {
  const response = exception.getResponse();

  if (typeof response === 'string') return response;

  const message = (response as { message?: unknown }).message;

  if (typeof message === 'string') return message;
  if (Array.isArray(message)) return message.join('; ');

  return exception.message;
};
