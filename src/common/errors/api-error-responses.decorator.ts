import { applyDecorators } from '@nestjs/common';
import { ApiExtension, ApiResponse } from '@nestjs/swagger';
import { ERROR_CATALOG, ErrorCode } from './error-codes';
import { ErrorResponse } from './error-response.dto';

/**
 * Declares the catalog codes an operation can emit.
 *
 * Takes codes rather than statuses because the code is what a client branches
 * on; the status is derived from the catalog, so the two can never disagree in
 * the document. Codes sharing a status collapse into one response entry whose
 * description enumerates them.
 *
 * The `x-error-codes` extension carries the machine-readable list, so a
 * generated client can build an exhaustive error union without scraping prose.
 */
export const ApiErrorResponses = (
  ...codes: ErrorCode[]
): ReturnType<typeof applyDecorators> => {
  const byStatus = new Map<number, ErrorCode[]>();

  for (const code of codes) {
    const { status } = ERROR_CATALOG[code];
    byStatus.set(status, [...(byStatus.get(status) ?? []), code]);
  }

  const responses = [...byStatus.entries()].map(([status, statusCodes]) =>
    ApiResponse({
      status,
      type: ErrorResponse,
      description: statusCodes
        .map((code) => `\`${code}\` — ${ERROR_CATALOG[code].description}`)
        .join('\n\n'),
    }),
  );

  return applyDecorators(...responses, ApiExtension('x-error-codes', codes));
};
