import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { ErrorResponse } from 'src/common/errors/error-response.dto';
import { PaginationQuery } from 'src/common/pagination/pagination-query.dto';

export const OPENAPI_PATH = 'docs';
export const OPENAPI_JSON_PATH = 'openapi.json';

const DESCRIPTION = `
The support API for Nivara Desk — a multitenant, two-sided customer-support helpdesk.

**Conventions every endpoint obeys:**

- **Success** — single resources are returned bare; collections wrap as \`{ data, nextCursor }\`. HTTP status discriminates success from error, so success bodies need no envelope.
- **Pagination** — cursor/keyset, never offset. \`limit\` defaults to 25 and caps at 100. There is no \`total\`. Default order is newest-first. The cursor is opaque — pass it back unmodified.
- **Errors** — always \`{ error: { code, message, details? } }\`. Branch on \`code\`, drawn from the closed catalog at \`GET /meta/error-codes\`. \`details\` appears only on 422.
- **Unknown query parameters are rejected with 400**, never silently ignored.
- **404, never 403, for records you cannot see** — a record belonging to another tenant is indistinguishable from one that does not exist.
`.trim();

/**
 * Builds the OpenAPI document from the code.
 *
 * Two downstream repos generate clients against this document, so it is
 * generated rather than hand-maintained — a hand-written spec drifts from the
 * server the first time someone forgets to update it.
 */
export const buildOpenApiDocument = (app: INestApplication): OpenAPIObject =>
  SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Nivara Desk API')
      .setDescription(DESCRIPTION)
      .setVersion('0.1.0')
      .addTag('health', 'Liveness')
      .addTag('meta', 'Published contracts — error codes and scopes')
      .build(),
    {
      // Registered so the shared kit's schemas appear in the document even
      // before an endpoint references them.
      extraModels: [ErrorResponse, PaginationQuery],
    },
  );

export const setupOpenApi = (app: INestApplication): OpenAPIObject => {
  const document = buildOpenApiDocument(app);

  SwaggerModule.setup(OPENAPI_PATH, app, document, {
    jsonDocumentUrl: OPENAPI_JSON_PATH,
    swaggerOptions: { persistAuthorization: true },
  });

  return document;
};
