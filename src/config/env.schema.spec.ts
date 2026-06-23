import { validateEnv } from './env.schema';

/**
 * The two things the application cannot invent: somewhere to store data, and a
 * key to sign sessions with. Every case below starts from them. This is still
 * the key-free path — compose supplies both itself, as throwaway local
 * defaults, and the developer supplies no credentials of any kind.
 */
const MINIMUM = {
  DATABASE_URL: 'postgres://app_user:pw@localhost:5432/nivara',
  JWT_SECRET: 'a-test-secret-of-at-least-thirty-two-characters',
};

const validate = (overrides: Record<string, unknown> = {}) =>
  validateEnv({ ...MINIMUM, ...overrides });

describe('validateEnv', () => {
  it('boots on the connection string alone', () => {
    // The key-free `docker compose up` path depends on this.
    expect(() => validate()).not.toThrow();
  });

  it('refuses to boot without a database', () => {
    // Nothing meaningful works without it, so failing here beats failing at the
    // first query with a stack trace that names neither cause nor fix.
    expect(() => validateEnv({ JWT_SECRET: MINIMUM.JWT_SECRET })).toThrow(
      /DATABASE_URL/,
    );
  });

  describe('the token-signing secret', () => {
    it('refuses to boot without one', () => {
      expect(() => validateEnv({ DATABASE_URL: MINIMUM.DATABASE_URL })).toThrow(
        /JWT_SECRET/,
      );
    });

    /**
     * HS256 accepts a key of any length, so a short secret produces no error
     * anywhere downstream — it produces a forgeable token, which is a failure
     * nothing observes until it is exploited. The floor is the only place that
     * can be caught.
     */
    it('refuses one too short to be worth signing with', () => {
      expect(() => validate({ JWT_SECRET: 'short' })).toThrow(/JWT_SECRET/);
    });
  });

  it('leaves Google and Slack dormant when entirely absent', () => {
    const env = validate();

    expect(env.GOOGLE_CLIENT_ID).toBeUndefined();
    expect(env.SLACK_SIGNING_SECRET).toBeUndefined();
  });

  it('treats a blank var as absent rather than as a value', () => {
    expect(
      validate({ GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' })
        .GOOGLE_CLIENT_ID,
    ).toBeUndefined();
  });

  it('rejects a half-configured Google integration', () => {
    expect(() => validate({ GOOGLE_CLIENT_ID: 'id-only' })).toThrow(
      /Google OIDC is partially configured/,
    );
  });

  it('rejects a half-configured Slack integration', () => {
    expect(() => validate({ SLACK_BOT_TOKEN: 'xoxb-token-only' })).toThrow(
      /Slack is partially configured/,
    );
  });

  it('accepts a fully configured optional integration', () => {
    expect(() =>
      validate({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' }),
    ).not.toThrow();
  });

  it('coerces PORT and defaults it', () => {
    expect(validate().PORT).toBe(3000);
    expect(validate({ PORT: '8080' }).PORT).toBe(8080);
  });

  it('rejects a PORT that is not a port', () => {
    expect(() => validate({ PORT: 'http' })).toThrow(/Invalid configuration/);
  });

  it('reads RUN_SCHEDULER as a flag, defaulting off', () => {
    expect(validate().RUN_SCHEDULER).toBe(false);
    expect(validate({ RUN_SCHEDULER: 'true' }).RUN_SCHEDULER).toBe(true);
    expect(validate({ RUN_SCHEDULER: '1' }).RUN_SCHEDULER).toBe(true);
    expect(validate({ RUN_SCHEDULER: 'false' }).RUN_SCHEDULER).toBe(false);
  });

  describe('the owner credential', () => {
    const OWNER = { MIGRATE_DATABASE_URL: 'postgres://owner:pw@host:5432/db' };

    it('is refused in a production process', () => {
      // The owner role bypasses row-level security. A deployed process holding
      // it makes every tenant policy advisory, so this is worth a failed boot.
      expect(() => validate({ ...OWNER, NODE_ENV: 'production' })).toThrow(
        /MIGRATE_DATABASE_URL must not be present in a production process/,
      );
    });

    it('is tolerated in development, where one .env serves the CLI too', () => {
      expect(() =>
        validate({ ...OWNER, NODE_ENV: 'development' }),
      ).not.toThrow();
      expect(() => validate({ ...OWNER, NODE_ENV: 'test' })).not.toThrow();
    });
  });

  it('names every offending key at once', () => {
    expect(() => validate({ PORT: 'nope', NODE_ENV: 'staging' })).toThrow(
      /PORT[\s\S]*NODE_ENV|NODE_ENV[\s\S]*PORT/,
    );
  });
});
