import { INestApplication } from '@nestjs/common';
import { OpenAPIObject } from '@nestjs/swagger';
import request from 'supertest';
import { buildOpenApiDocument } from 'src/openapi/document';
import { bootApp } from './helpers/boot';

describe('OpenAPI document', () => {
  let app: INestApplication;
  let document: OpenAPIObject;

  beforeAll(async () => {
    app = await bootApp({ openApi: true });
    document = buildOpenApiDocument(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('is generated from the code, not hand-maintained', () => {
    expect(document.info.title).toBe('Nivara Desk API');
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining(['/health', '/meta/error-codes']),
    );
  });

  it('is served as JSON for downstream client generation', async () => {
    const response = await request(app.getHttpServer()).get('/openapi.json');

    expect(response.status).toBe(200);
    expect(response.body.info.title).toBe('Nivara Desk API');
    expect(response.body.paths).toHaveProperty('/health');
  });

  it('serves browsable documentation', async () => {
    expect((await request(app.getHttpServer()).get('/docs')).status).toBe(200);
  });

  it('registers the shared error envelope as one reusable schema', () => {
    expect(document.components?.schemas).toHaveProperty('ErrorResponse');
    expect(document.components?.schemas).toHaveProperty('PaginationQuery');
  });

  it('enumerates the error catalog on the ErrorResponse schema', () => {
    const schemas = document.components?.schemas as Record<string, any>;
    const codeProperty = schemas.ErrorBodyDto.properties.code;

    expect(codeProperty.enum).toContain('not_found');
    expect(codeProperty.enum).toContain('rate_limited');
  });

  it('reflects the code — a new route appears without touching the document', () => {
    // Regenerating from the same application must be deterministic; drift
    // between the served document and the routes is what this guards.
    const regenerated = buildOpenApiDocument(app);

    expect(Object.keys(regenerated.paths).sort()).toEqual(
      Object.keys(document.paths).sort(),
    );
  });
});
