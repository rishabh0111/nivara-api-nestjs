import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ERROR_CATALOG, ERROR_CODES } from 'src/common/errors/error-codes';
import { bootApp } from './helpers/boot';

describe('GET /meta/error-codes', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await bootApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('publishes the whole catalog', async () => {
    const response = await request(app.getHttpServer()).get(
      '/meta/error-codes',
    );

    expect(response.status).toBe(200);
    expect(response.body.map((e: { code: string }) => e.code).sort()).toEqual(
      [...ERROR_CODES].sort(),
    );
  });

  it('gives every code a status and a description', async () => {
    const { body } = await request(app.getHttpServer()).get(
      '/meta/error-codes',
    );

    for (const entry of body) {
      expect(entry).toEqual({
        code: expect.any(String),
        status: expect.any(Number),
        description: expect.any(String),
      });
    }
  });

  it('reports the same status the server actually returns for a code', async () => {
    const { body } = await request(app.getHttpServer()).get(
      '/meta/error-codes',
    );

    const published = Object.fromEntries(
      body.map((e: { code: string; status: number }) => [e.code, e.status]),
    );

    // The catalog is served from the same constant the exception filter throws
    // from, so the published status can never drift from the emitted one.
    for (const code of ERROR_CODES) {
      expect(published[code]).toBe(ERROR_CATALOG[code].status);
    }
  });

  it('rejects an unknown query parameter', async () => {
    const response = await request(app.getHttpServer()).get(
      '/meta/error-codes?bogus=1',
    );

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('invalid_filter');
  });

  it('uses snake_case codes throughout', async () => {
    const { body } = await request(app.getHttpServer()).get(
      '/meta/error-codes',
    );

    for (const entry of body) {
      expect(entry.code).toMatch(/^[a-z][a-z0-9]*(_[a-z0-9]+)*$/);
    }
  });
});
