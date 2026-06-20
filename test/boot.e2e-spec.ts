import request from 'supertest';
import { bootAppUnderCurrentEnv } from './helpers/boot';
import { withEnv } from './helpers/env';

/**
 * The key-free `docker compose up` path is a hard requirement, not a
 * convenience: a first run that demands credentials fails the destination. Any
 * integration added later must stay dormant when unconfigured.
 */
describe('boot tolerance', () => {
  const ABSENT = {
    GOOGLE_CLIENT_ID: undefined,
    GOOGLE_CLIENT_SECRET: undefined,
    SLACK_SIGNING_SECRET: undefined,
    SLACK_BOT_TOKEN: undefined,
  };

  it('boots and serves with Google and Slack entirely absent', async () => {
    await withEnv(ABSENT, async () => {
      const app = await bootAppUnderCurrentEnv();

      try {
        expect((await request(app.getHttpServer()).get('/health')).status).toBe(
          200,
        );
        expect(
          (await request(app.getHttpServer()).get('/meta/error-codes')).status,
        ).toBe(200);
      } finally {
        await app.close();
      }
    });
  });

  it('boots with no environment configured at all', async () => {
    await withEnv(
      {
        ...ABSENT,
        DATABASE_URL: undefined,
        REDIS_URL: undefined,
        JWT_SECRET: undefined,
        WIDGET_SESSION_SECRET: undefined,
        PORT: undefined,
      },
      async () => {
        const app = await bootAppUnderCurrentEnv();

        try {
          expect(
            (await request(app.getHttpServer()).get('/health')).status,
          ).toBe(200);
        } finally {
          await app.close();
        }
      },
    );
  });

  it('refuses to boot on a half-configured integration', async () => {
    await withEnv(
      { ...ABSENT, GOOGLE_CLIENT_ID: 'id-without-a-secret' },
      async () => {
        // Absence is a deliberate choice; half-presence is a mistake, and
        // failing here beats discovering it at the first OAuth callback.
        await expect(bootAppUnderCurrentEnv()).rejects.toThrow(
          /partially configured/,
        );
      },
    );
  });
});
