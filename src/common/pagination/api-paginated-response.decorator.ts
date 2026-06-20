import { Type, applyDecorators } from '@nestjs/common';
import { ApiExtraModels, ApiOkResponse, getSchemaPath } from '@nestjs/swagger';

/**
 * The list-response schema, `{ data: T[], nextCursor }`, for one item type.
 *
 * Every collection endpoint uses this rather than hand-declaring its response,
 * which is what keeps the generated document uniform across resources — and
 * what lets `nivara-web` generate one pagination helper instead of one per
 * endpoint.
 */
export const ApiPaginatedResponse = <T extends Type<unknown>>(
  model: T,
  description?: string,
): ReturnType<typeof applyDecorators> =>
  applyDecorators(
    ApiExtraModels(model),
    ApiOkResponse({
      description,
      schema: {
        type: 'object',
        required: ['data', 'nextCursor'],
        properties: {
          data: {
            type: 'array',
            items: { $ref: getSchemaPath(model) },
          },
          nextCursor: {
            type: 'string',
            nullable: true,
            description:
              'Pass as `cursor` to fetch the next page. `null` means end of list. Opaque — do not parse.',
          },
        },
      },
    }),
  );
