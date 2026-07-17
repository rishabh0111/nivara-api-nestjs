import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { envSchema } from 'src/config/env.schema';

/**
 * The deployment wiring, asserted against the files that carry it.
 *
 * Unusual for this suite, which otherwise drives the booted application over
 * its public protocols, and the exception is deliberate: the invariants below
 * are not properties of any running process. "The owner credential is absent
 * from the deployed process" is a property of a Dockerfile and a compose file,
 * and the way it breaks is that somebody adds one line to a YAML file that
 * nothing reads until a deploy.
 *
 * Every assertion here is one whose failure mode is silent. A missing variable
 * in `.env.example` costs someone an afternoon; a credential added to the wrong
 * service costs the whole tenant-isolation guarantee, and neither shows up in a
 * test that boots the application.
 *
 * They are string comparisons over configuration files, which makes them
 * shallow, and shallow is the right depth: each one restates a decision that
 * has an argument written beside it in the file it reads.
 */

const root = join(__dirname, '..');
const read = (name: string) => readFileSync(join(root, name), 'utf8');

const dockerfile = read('Dockerfile');
const compose = read('docker-compose.yml');
const blueprint = read('render.yaml');
const envExample = read('.env.example');
const gitignore = read('.gitignore');

/** The owner role's connection string — the credential that bypasses RLS. */
const OWNER_CREDENTIAL = 'MIGRATE_DATABASE_URL';

/**
 * Every key the application reads, from the schema that reads them.
 *
 * Derived rather than listed, so the two "is this key documented / deployed"
 * tests below cannot pass by being out of date with the thing they check.
 */
const CONFIGURED_KEYS = Object.keys(envSchema._def.schema.shape);

/** The keys the blueprint actually declares, as opposed to merely mentions. */
const declaredInBlueprint = new Set(
  [...blueprint.matchAll(/^\s*- key: ([A-Z][A-Z0-9_]*)/gm)].map(
    ([, key]) => key,
  ),
);

describe('the deployment contract', () => {
  describe('migrate-then-boot', () => {
    it('names the migrate command once, and runs that same name everywhere', () => {
      // Local compose and the deployed release step apply migrations by the
      // same command, so "it works locally" is evidence about the deploy. Two
      // spellings of `prisma migrate deploy` would be two things to keep in
      // step, and the one that is wrong is the one nobody runs until a release.
      const scripts = JSON.parse(read('package.json')) as {
        scripts: Record<string, string>;
      };

      expect(scripts.scripts.release).toContain('prisma migrate deploy');
      expect(compose).toContain('npm run release');
      expect(blueprint).toContain('preDeployCommand: npm run release');
    });

    it('never migrates at application boot', () => {
      // Two instances booting together would race to migrate the same
      // database, and a boot-time migration would need the owner credential
      // inside the long-running process — which is the thing the role split
      // exists to prevent.
      expect(dockerfile).toMatch(/CMD .*node dist\/main/);
      expect(dockerfile).not.toMatch(/CMD .*migrate/);
    });
  });

  describe('the two database roles', () => {
    it('strips the owner credential before the application process starts', () => {
      // The mechanism, not the intention. The release step and the web process
      // share one environment on any platform that runs a pre-deploy hook in
      // the service's own container, so the credential has to be removed rather
      // than merely not supplied — `node` is then `exec`d with an environment
      // that never contained it.
      expect(dockerfile).toMatch(
        new RegExp(`CMD .*env -u ${OWNER_CREDENTIAL} .*node dist/main`),
      );
    });

    it('refuses to boot a production process that carries one anyway', () => {
      // The backstop beneath the entrypoint, for a platform whose start command
      // is configured elsewhere.
      const result = envSchema.safeParse({
        NODE_ENV: 'production',
        DATABASE_URL: 'postgres://app_user@localhost:5432/nivara',
        MIGRATE_DATABASE_URL: 'postgres://nivara_owner@localhost:5432/nivara',
        JWT_SECRET: 'a'.repeat(32),
        WIDGET_SESSION_SECRET: 'b'.repeat(32),
      });

      expect(result.success).toBe(false);
    });

    it('keeps the owner credential out of the compose service that serves', () => {
      // Local compose runs the same split, so development exercises the real
      // policies. The `migrate` service holds the credential; `api` must not.
      const api = compose.slice(compose.indexOf('\n  api:'));

      // An assignment, not a mention: the service carries a comment explaining
      // why the credential is absent, and that comment is the reason the
      // absence survives the next person editing the file.
      expect(api).not.toMatch(new RegExp(`^\\s+${OWNER_CREDENTIAL}:`, 'm'));
      expect(api).toContain('app_user');
    });

    it('gives the runtime no direct connection, only the pooled one', () => {
      // Tenant context is set transaction-locally, which is safe under
      // transaction-mode pooling — so the direct endpoint is a migration
      // concern and the runtime has no reason to hold one.
      expect(envSchema.safeParse({}).success).toBe(false);
      expect(CONFIGURED_KEYS).not.toContain('DIRECT_DATABASE_URL');
    });
  });

  describe('configuration', () => {
    it('documents every key the application reads', () => {
      // `.env.example` is the only description of the configuration surface
      // anyone deploying this will read. A key added to the schema and not to
      // the file is invisible until something fails to start.
      const documented = new Set(
        [...envExample.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map(([, key]) => key),
      );

      for (const key of CONFIGURED_KEYS) {
        expect([key, documented.has(key)]).toEqual([key, true]);
      }
    });

    it('declares the same keys in the deployment blueprint', () => {
      // The blueprint is what a fresh deployment is created from, so a key
      // missing there is a capability that is off in production and on
      // everywhere else — including in the head of whoever wrote the schema.
      //
      // `PORT` is the one exception, and it is the platform's to set: the
      // service is handed a port to listen on, and a blueprint that named one
      // would be arguing with it.
      const platformSupplied = ['PORT'];

      // A declaration, not a mention. Most of these keys also appear in the
      // blueprint's comments, so a substring search would report the file
      // complete while it declared nothing at all.
      for (const key of CONFIGURED_KEYS) {
        if (platformSupplied.includes(key)) continue;

        expect([key, declaredInBlueprint.has(key)]).toEqual([key, true]);
      }
    });

    it('commits no secret values', () => {
      // Nothing real in git: the blueprint declares that a variable exists and
      // the value is supplied out of band.
      // `\r?\n` because a checkout on Windows may carry CRLF, and a regex that
      // silently matched nothing would make this test pass by finding no
      // secrets to object to — the exact failure mode it exists to catch.
      const declarations = [
        ...blueprint.matchAll(/- key: ([A-Z_]+)\r?\n\s+(\w+): ?(.*)/g),
      ];

      const secrets = declarations.filter(([, key]) =>
        /SECRET|TOKEN|URL/.test(key),
      );

      expect(secrets.length).toBeGreaterThan(0);

      for (const [, key, field] of secrets) {
        expect([key, field]).toEqual([
          key,
          expect.stringMatching(/sync|generateValue/),
        ]);
      }
    });

    it('keeps the real .env out of the repository', () => {
      expect(gitignore).toMatch(/^\.env$/m);
    });
  });

  describe('the scheduler split', () => {
    it('is a flag in the deployment, not a branch in the code', () => {
      // Moving the ticker to its own always-on service means setting this to
      // false here and adding a second service with it true. The claim that it
      // is a deploy change rather than a rewrite is only true while the flag is
      // the whole of the mechanism.
      expect(blueprint).toContain('RUN_SCHEDULER');
      expect(envExample).toMatch(/^RUN_SCHEDULER=/m);
    });
  });

  describe('health', () => {
    it('points the platform health check at liveness, never readiness', () => {
      // Failing this check restarts the instance, and readiness reports
      // conditions that are not reasons to restart — a database blip resolves
      // itself, and a restart during one kills the process that would have
      // recovered.
      expect(blueprint).toContain('healthCheckPath: /health');
      expect(blueprint).not.toContain('healthCheckPath: /health/ready');
    });

    it('does the same in compose, for the same reason', () => {
      expect(compose).toContain('localhost:3000/health');
      expect(compose).not.toContain('localhost:3000/health/ready');
    });
  });
});
