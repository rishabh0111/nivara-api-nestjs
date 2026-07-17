import request from 'supertest';
import { bootAppUnderCurrentEnv } from './helpers/boot';
import { withEnv } from './helpers/env';
import { UNREACHABLE_DATABASE_URL } from './helpers/unreachable-urls';

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

  /**
   * The dormancy half of "feature-gated and dormant when unconfigured", and the
   * one claim the Google suite's stub could not honestly make — it reports
   * itself configured by construction, so only the real class booted under a
   * real absent environment can answer this.
   *
   * A distinguishable refusal rather than a 404, deliberately. Whether *this
   * deployment* configured Google is a fact about the deployment and not about
   * anybody's account, and a client needs it to decide whether to offer the
   * button at all. Every refusal after the gate is indistinguishable.
   */
  it('leaves Google sign-in dormant, and the password path untouched', async () => {
    await withEnv(ABSENT, async () => {
      const app = await bootAppUnderCurrentEnv();

      try {
        const dormant = await request(app.getHttpServer())
          .post('/auth/google')
          .send({
            tenantId: '019f7b5a-0000-7000-8000-000000000000',
            code: 'a-code',
            redirectUri: 'https://app.nivara.example/auth/google/callback',
          });

        expect(dormant.status).toBe(503);
        expect(dormant.body.error.code).toBe('integration_dormant');

        // The route being dormant must cost the other one nothing. A bad
        // password here is a 401 from the password path having run, not a 503.
        const password = await request(app.getHttpServer())
          .post('/auth/sign-in')
          .send({
            tenantId: '019f7b5a-0000-7000-8000-000000000000',
            email: 'nobody@meridian.test',
            password: 'not-the-password',
          });

        expect(password.status).toBe(401);
      } finally {
        await app.close();
      }
    });
  });

  it('boots on the three required keys, with every optional one absent', async () => {
    // The key-free path, stated exactly. Three keys are required — the
    // connection string and the two signing secrets — and compose supplies all
    // three as throwaway local defaults, so a clean clone still needs no
    // credentials from the developer. Everything else is absent here: no Redis,
    // no Google, no Slack, not even a port.
    //
    // The secrets are required rather than defaulted on purpose: a signing key
    // with a built-in fallback is a forgeable token in any deployment that
    // forgets to set one, which is a silent failure rather than a loud one.
    await withEnv(
      {
        ...ABSENT,
        DATABASE_URL: UNREACHABLE_DATABASE_URL,
        REDIS_URL: undefined,
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
