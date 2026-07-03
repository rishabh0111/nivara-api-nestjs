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

    // The runtime credential: the least-privileged, non-BYPASSRLS `app_user`
    // over the pooled endpoint. Required — there is no meaningful application
    // without it, and booting without one only defers the failure.
    DATABASE_URL: z.string().trim().min(1),

    // The owner credential, over the direct endpoint. Read by the Prisma CLI
    // via `prisma.config.ts`, and by nothing in the application — see the
    // production check below.
    MIGRATE_DATABASE_URL: optionalString,

    REDIS_URL: optionalString,

    // Signs staff access tokens. Required as of staff authentication, and
    // floored at 32 bytes: HS256 accepts a key of any length, so a short
    // secret is not an error anywhere downstream — it is simply a forgeable
    // token, which is the failure this refuses to boot on.
    //
    // The key-free first run survives it because compose bakes in a throwaway
    // value, exactly as it does for DATABASE_URL.
    JWT_SECRET: z.string().trim().min(32),

    // Signs anonymous widget sessions, and required as of the widget surface —
    // the tightening the placeholder above this line promised.
    //
    // A *separate* secret from JWT_SECRET rather than a second audience on the
    // same key, and the separation is load-bearing rather than tidy. One key
    // signing both would mean a staff token and a widget session differ only by
    // their claims, so the whole distinction between "an agent" and "an
    // anonymous visitor" would rest on the claim-shape check in one function.
    // With two keys, a token minted for one surface does not verify on the
    // other at all: the refusal happens at the signature, before any claim is
    // read, and it holds even if that function is one day got wrong.
    //
    // Floored at 32 bytes for the reason JWT_SECRET is — HS256 takes a key of
    // any length, so a short one is not an error anywhere, just a forgeable
    // session. The key-free first run survives it because compose bakes in a
    // throwaway value, exactly as it does for the other two required keys.
    WIDGET_SESSION_SECRET: z.string().trim().min(32),

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

    // Row-level security is only a guarantee while the running process holds no
    // credential that can bypass it. The owner role does — it is a superuser
    // locally and a `neon_superuser` (so `BYPASSRLS`) on Neon — so its presence
    // in a deployed process is a misconfiguration serious enough to refuse to
    // boot on, rather than a latent one discovered by a cross-tenant leak.
    //
    // Development and test are exempt: there, one `.env` legitimately serves
    // both the application and the migration CLI.
    if (env.NODE_ENV === 'production' && env.MIGRATE_DATABASE_URL) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'MIGRATE_DATABASE_URL must not be present in a production process. It is the owner credential, which bypasses row-level security; supply it to the release-phase migrate step alone.',
        path: ['MIGRATE_DATABASE_URL'],
      });
    }
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
