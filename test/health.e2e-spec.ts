import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { bootApp, bootAppUnderCurrentEnv } from './helpers/boot';
import { withEnv } from './helpers/env';
import { UNREACHABLE_DATABASE_URL } from './helpers/database-urls';

describe('GET /health', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await bootApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers 200 with a liveness body', async () => {
    const response = await request(app.getHttpServer()).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: 'ok',
      uptimeSeconds: expect.any(Number),
    });
  });

  it('answers with Postgres unreachable and Redis unconfigured', async () => {
    // The keep-warm ping must succeed whenever the process is alive. Pointing
    // DATABASE_URL at a port nothing is listening on, dropping REDIS_URL, and
    // still answering 200 is the strongest available proof that liveness
    // reaches neither. (The connection string itself is required now — the
    // tenancy spine needs one — so the test denies the connection, not the
    // configuration.)
    await withEnv(
      {
        DATABASE_URL: UNREACHABLE_DATABASE_URL,
        REDIS_URL: undefined,
      },
      async () => {
        const isolated = await bootAppUnderCurrentEnv();

        try {
          const response = await request(isolated.getHttpServer()).get(
            '/health',
          );
          expect(response.status).toBe(200);
        } finally {
          await isolated.close();
        }
      },
    );
  });

  it('stays fast and stable under repeated pings', async () => {
    const responses = await Promise.all(
      Array.from({ length: 20 }, () =>
        request(app.getHttpServer()).get('/health'),
      ),
    );

    expect(responses.map((r) => r.status)).toEqual(Array(20).fill(200));
  });
});
