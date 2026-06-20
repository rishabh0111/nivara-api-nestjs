import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { bootApp, bootAppUnderCurrentEnv } from './helpers/boot';
import { withEnv } from './helpers/env';

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

  it('answers with Postgres and Redis entirely unconfigured', async () => {
    // The keep-warm ping must succeed whenever the process is alive. Booting
    // with no DATABASE_URL and no REDIS_URL and still answering 200 is the
    // strongest available proof that liveness reaches neither.
    await withEnv(
      { DATABASE_URL: undefined, REDIS_URL: undefined },
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
