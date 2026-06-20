import { z } from 'zod';

/** Treats `""` as absent, so a blank var in a `.env` reads as unconfigured. */
const optionalString = z
  .string()
  .trim()
  .min(1)
  .optional()
  .or(z.literal('').transform(() => undefined));

const booleanish = (fallback: boolean) =>
  z
    .enum(['true', 'false', '1', '0'])
    .optional()
    .transform((v) => (v === undefined ? fallback : v === 'true' || v === '1'));

const port = z.coerce.number().int().min(1).max(65535);

/**
 * Every configuration key the application reads.
 *
 * Two rules hold this together, and both are load-bearing for the promise that
 * a clean clone runs with `docker compose up` and no credentials:
 *
 * 1. Optional integrations are optional *in the schema*. Absent Google or Slack
 *    configuration leaves the application fully bootable — the capability is
 *    dormant, never fatal.
 * 2. Half-configured integrations are fatal. Absence is a deliberate choice;
 *    supplying one of a pair is a mistake, and failing at boot beats
 *    discovering it at the first callback.
 */
export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    PORT: port.default(3000),

    // Infrastructure. Optional here because nothing reads them yet; the ticket
    // that introduces Prisma makes DATABASE_URL required.
    DATABASE_URL: optionalString,
    REDIS_URL: optionalString,

    // Secrets for surfaces not yet built. Same reasoning as above — the ticket
    // that introduces each one tightens it to required.
    JWT_SECRET: optionalString,
    WIDGET_SESSION_SECRET: optionalString,

    // Optional integration: Google OIDC staff login.
    GOOGLE_CLIENT_ID: optionalString,
    GOOGLE_CLIENT_SECRET: optionalString,

    // Optional integration: Slack source adapter.
    SLACK_SIGNING_SECRET: optionalString,
    SLACK_BOT_TOKEN: optionalString,

    // In-process scheduler. Off here, on in the deployed web service — the flag
    // is what keeps splitting the scheduler out a deploy change, not a rewrite.
    RUN_SCHEDULER: booleanish(false),

    SWAGGER_ENABLED: booleanish(true),
  })
  .superRefine((env, ctx) => {
    const partial = (name: string, keys: string[], present: boolean[]) => {
      if (present.some(Boolean) && !present.every(Boolean)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${name} is partially configured. Set all of ${keys.join(', ')}, or none of them to leave ${name} dormant.`,
          path: [keys[0]],
        });
      }
    };

    partial(
      'Google OIDC',
      ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
      [!!env.GOOGLE_CLIENT_ID, !!env.GOOGLE_CLIENT_SECRET],
    );

    partial(
      'Slack',
      ['SLACK_SIGNING_SECRET', 'SLACK_BOT_TOKEN'],
      [!!env.SLACK_SIGNING_SECRET, !!env.SLACK_BOT_TOKEN],
    );
  });

export type Env = z.infer<typeof envSchema>;

/**
 * Validates the process environment at boot. A configuration mistake stops the
 * application here, with every offending key named at once, rather than
 * surfacing as an undefined read somewhere downstream.
 */
export const validateEnv = (raw: Record<string, unknown>): Env => {
  const result = envSchema.safeParse(raw);

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');

    throw new Error(`Invalid configuration:\n${problems}`);
  }

  return result.data;
};
