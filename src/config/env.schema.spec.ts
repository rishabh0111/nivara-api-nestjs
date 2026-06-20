import { validateEnv } from './env.schema';

describe('validateEnv', () => {
  it('boots on a completely empty environment', () => {
    // The key-free `docker compose up` path depends on this.
    expect(() => validateEnv({})).not.toThrow();
  });

  it('leaves Google and Slack dormant when entirely absent', () => {
    const env = validateEnv({});

    expect(env.GOOGLE_CLIENT_ID).toBeUndefined();
    expect(env.SLACK_SIGNING_SECRET).toBeUndefined();
  });

  it('treats a blank var as absent rather than as a value', () => {
    expect(
      validateEnv({ GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '' })
        .GOOGLE_CLIENT_ID,
    ).toBeUndefined();
  });

  it('rejects a half-configured Google integration', () => {
    expect(() => validateEnv({ GOOGLE_CLIENT_ID: 'id-only' })).toThrow(
      /Google OIDC is partially configured/,
    );
  });

  it('rejects a half-configured Slack integration', () => {
    expect(() => validateEnv({ SLACK_BOT_TOKEN: 'xoxb-token-only' })).toThrow(
      /Slack is partially configured/,
    );
  });

  it('accepts a fully configured optional integration', () => {
    expect(() =>
      validateEnv({ GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret' }),
    ).not.toThrow();
  });

  it('coerces PORT and defaults it', () => {
    expect(validateEnv({}).PORT).toBe(3000);
    expect(validateEnv({ PORT: '8080' }).PORT).toBe(8080);
  });

  it('rejects a PORT that is not a port', () => {
    expect(() => validateEnv({ PORT: 'http' })).toThrow(
      /Invalid configuration/,
    );
  });

  it('reads RUN_SCHEDULER as a flag, defaulting off', () => {
    expect(validateEnv({}).RUN_SCHEDULER).toBe(false);
    expect(validateEnv({ RUN_SCHEDULER: 'true' }).RUN_SCHEDULER).toBe(true);
    expect(validateEnv({ RUN_SCHEDULER: '1' }).RUN_SCHEDULER).toBe(true);
    expect(validateEnv({ RUN_SCHEDULER: 'false' }).RUN_SCHEDULER).toBe(false);
  });

  it('names every offending key at once', () => {
    expect(() => validateEnv({ PORT: 'nope', NODE_ENV: 'staging' })).toThrow(
      /PORT[\s\S]*NODE_ENV|NODE_ENV[\s\S]*PORT/,
    );
  });
});
