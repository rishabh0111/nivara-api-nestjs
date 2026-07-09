import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';
import { REFRESH_COOKIE } from 'src/auth/refresh-cookie';
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
- **Authority** — an operation that needs a named permission carries it as \`x-required-permission\`, derived from the guard that enforces it rather than written by hand. The same vocabulary is the scope namespace for service tokens: there is one set of permission names, not two.
- **Safe retries** — any authenticated \`POST\` accepts an optional \`Idempotency-Key\` header. Send one and the effect happens at most once however many times you retry: a completed request replays its original status and body verbatim, marked \`Idempotency-Replayed: true\`. A duplicate arriving while the original is still running answers \`409 idempotency_in_flight\` and is safe to retry; the same key sent with a different body answers \`422 idempotency_key_reused\`. Keys are honoured for 24 hours, scoped per caller and per request. Omitting the header is not an error — it simply carries no guarantee.
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
      .addTag('auth', 'Sign-in, session refresh, and the current principal')
      .addTag('staff', 'Provisioning colleagues into a tenant by invitation')
      // The default scheme. Every operation without an explicit `@Public()` is
      // authenticated, so declaring it globally matches what the guard does
      // rather than restating it per operation.
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description:
            'A 15-minute staff access token from `POST /auth/sign-in`. Hold it in memory and refresh before it expires.',
        },
        'bearer',
      )
      .addCookieAuth(
        REFRESH_COOKIE,
        {
          type: 'apiKey',
          in: 'cookie',
          description:
            'The httpOnly refresh cookie. Set by sign-in, sent automatically by the browser, and readable by no script — including this page.',
        },
        REFRESH_COOKIE,
      )
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
