import request from 'supertest';
import { bootAppUnderCurrentEnv } from './helpers/boot';
import { withEnv } from './helpers/env';
import { UNREACHABLE_DATABASE_URL } from './helpers/database-urls';

/**
 * The key-free `docker compose up` path is a hard requirement, not a
 * convenience: a first run that demands credentials fails the destination. Any
 * integration added later must stay dormant when unconfigured.
 */
describe('boot tolerance', () => {
  /**
   * Every case here boots a fresh application through
   * `bootAppUnderCurrentEnv()`, which resets the module registry and so pays
   * for compiling the whole module graph again. That is inherent to what these
   * assert — configuration is read when the module is *evaluated*, so a second
   * boot under a different environment has to be a genuinely fresh one — and it
   * takes well over Jest's 5s default when the suite runs in parallel on a busy
   * machine.
   *
   * Raised rather than left to flake, because none of these tests is about how
   * long a boot takes: each asserts that the application boots *at all* under a
   * given environment. A timeout that fails on a loaded machine is a false
   * report about configuration tolerance.
   */
  jest.setTimeout(30_000);

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

  it('boots on the database connection string alone', async () => {
    // Everything else absent. This is the key-free path: compose supplies the
    // connection string itself, as a throwaway local default, so a clean clone
    // still needs no credentials from the developer.
    await withEnv(
      {
        ...ABSENT,
        DATABASE_URL: UNREACHABLE_DATABASE_URL,
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
