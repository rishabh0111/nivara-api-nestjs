import { load } from 'js-yaml';
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
const releaseWorkflow = read('.github/workflows/release.yml');

/** The owner role's connection string — the credential that bypasses RLS. */
const OWNER_CREDENTIAL = 'MIGRATE_DATABASE_URL';

/**
 * Every key the application reads, from the schema that reads them.
 *
 * Derived rather than listed, so the two "is this key documented / deployed"
 * tests below cannot pass by being out of date with the thing they check.
 */
const CONFIGURED_KEYS = Object.keys(envSchema._def.schema.shape);

/**
 * The release workflow, parsed rather than grepped.
 *
 * Everything else here compares strings, and says why. The workflow is the
 * exception because what its assertions turn on is *shape* — which job is
 * guarded on which other job's output — and a regex over two jobs' worth of
 * YAML would be matching text that happens to sit near the thing it means to
 * check. Once parsed, the step-order assertion above reads from the same tree,
 * since a whole-file regex for step names could not tell the two jobs apart.
 */
type ReleaseWorkflow = {
  jobs: Record<
    string,
    {
      needs?: string | string[];
      if?: string;
      outputs?: Record<string, string>;
      steps: {
        name?: string;
        id?: string;
        run?: string;
        env?: Record<string, string>;
      }[];
    }
  >;
};

const workflow = load(releaseWorkflow) as ReleaseWorkflow;

/** The job that decides whether this repository has a deployment at all. */
const gate = workflow.jobs['configured'];

/** The job that migrates and then asks for the deploy. */
const release = workflow.jobs['release'];

/** The gate's shell — the only step in it that runs anything. */
const check = gate?.steps.find((step) => step.run)?.run ?? '';

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
      expect(releaseWorkflow).toContain('npm run release');
    });

    it('never migrates at application boot', () => {
      // Two instances booting together would race to migrate the same
      // database, and a boot-time migration would need the owner credential
      // inside the long-running process — which is the thing the role split
      // exists to prevent.
      expect(dockerfile).toMatch(/CMD .*node dist\/main/);
      expect(dockerfile).not.toMatch(/CMD .*migrate/);
    });

    it('lets nothing but the release deploy, so the order cannot be lost', () => {
      // The free tier has no pre-deploy hook, so the ordering is imposed by the
      // release workflow migrating and only then calling the deploy hook. That
      // holds only while a push cannot deploy on its own: with `autoDeploy` on,
      // the two would race and the winner would decide whether the new instance
      // met the schema it was built for.
      expect(blueprint).toMatch(/^\s*autoDeploy: false/m);
      expect(releaseWorkflow).toContain('RENDER_DEPLOY_HOOK_URL');

      // And the deploy is a later step than the migration in the same job, so
      // a failed migration cannot be followed by a deploy. Compared by step
      // name rather than by command, because both strings also appear in the
      // file's opening commentary — where their order means nothing.
      const steps = release.steps
        .map((step) => step.name)
        .filter((name) => name !== undefined);

      expect(steps).toEqual(['Apply migrations', 'Trigger the deploy']);
    });
  });

  /**
   * A clone of this repository has no deployment, and that is a supported
   * state rather than a broken one — the same terms every optional integration
   * is on. Absent configuration leaves the capability dormant; it is never
   * fatal.
   *
   * The workflow said exactly that in prose and did not do it, which is what
   * these exist to hold. The argument for each rule is beside the rule, in
   * `.github/workflows/release.yml`.
   */
  describe('a repository with no deployment configured', () => {
    it('gates the whole release on the secrets existing', () => {
      // Structural, and it has to be: the guarantee is that *nothing*
      // effectful can run ahead of the check, which is a property of the job
      // graph rather than of any step. The `secrets` context is unavailable in
      // an `if:`, so the check has to be a job that reads them and reports.
      expect(Object.keys(gate.outputs ?? {})).toEqual(['configured']);
      expect([release.needs].flat()).toContain('configured');
      expect(release.if).toContain('needs.configured.outputs.configured');

      // And nothing gates the gate, or the check could not run to say no.
      expect(gate.if).toBeUndefined();
    });

    it('decides on both secrets, so neither can be forgotten silently', () => {
      // Reading them into the step's environment rather than interpolating
      // them into the script: an expression expanded into shell would put a
      // connection string in the command line, and a secret with a quote in it
      // would be a syntax error at best.
      const supplied = Object.values(gate.steps[0].env ?? {}).join(' ');

      expect(supplied).toContain('secrets.MIGRATE_DATABASE_URL');
      expect(supplied).toContain('secrets.RENDER_DEPLOY_HOOK_URL');
    });

    /**
     * The three outcomes, read off the script rather than run.
     *
     * Shallow, and deliberately: executing it would make the suite depend on a
     * POSIX shell being present, which is a new requirement on a developer's
     * machine for four lines of `if`. What that costs is guarded against
     * below — each case pins the *condition* it fires under and not merely the
     * presence of a line, because "contains `exit 1`" is satisfied by a script
     * that does nothing else, and "contains `configured=false`" by one that
     * never says true and quietly disables every deploy forever.
     */
    it('releases only when both secrets are present', () => {
      expect(check).toMatch(
        /if \[ -n "\$MIGRATE" \] && \[ -n "\$HOOK" \]; then\s+echo 'configured=true'/,
      );
    });

    it('skips quietly when neither is', () => {
      expect(check).toMatch(
        /if \[ -z "\$MIGRATE" \] && \[ -z "\$HOOK" \]; then\s+echo 'configured=false'/,
      );
    });

    it('fails a half-configured release rather than running half of it', () => {
      // The one case that must not be quiet, and the only one left once the
      // two above have returned — so it is asserted as the fall-through, which
      // is the property that actually makes it unreachable by anything else.
      expect(check.trimEnd().endsWith('exit 1')).toBe(true);
      expect(check).toContain('::error::');
    });
  });

  describe('the two database roles', () => {
    it('never gives the deployed service the owner credential at all', () => {
      // The primary mechanism, and the strongest form the guarantee takes: the
      // credential belongs to the release step, which runs in CI and holds it
      // as a secret there. The deployed service cannot bypass row-level
      // security because there is nothing in its environment to bypass it with.
      expect(declaredInBlueprint).not.toContain(OWNER_CREDENTIAL);
      expect(releaseWorkflow).toContain(OWNER_CREDENTIAL);
    });

    it('strips it from the process anyway, in case somebody adds it', () => {
      // Second belt. A variable added in the platform's dashboard appears in
      // no file this test can read, so the entrypoint is what holds then —
      // `node` is `exec`d with an environment that never contained it.
      expect(dockerfile).toMatch(
        new RegExp(`CMD .*env -u ${OWNER_CREDENTIAL} .*node dist/main`),
      );
    });

    it('refuses to boot a production process that carries one anyway', () => {
      // Third belt, for the day somebody changes the entrypoint.
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
      // Two keys are deliberately absent, for opposite reasons. `PORT` is the
      // platform's to set — the service is handed a port to listen on, and a
      // blueprint naming one would be arguing with it. The owner credential is
      // absent because the whole role split rests on it being absent; the test
      // above asserts that directly.
      const deliberatelyAbsent = ['PORT', OWNER_CREDENTIAL];

      // A declaration, not a mention. Most of these keys also appear in the
      // blueprint's comments, so a substring search would report the file
      // complete while it declared nothing at all.
      for (const key of CONFIGURED_KEYS) {
        if (deliberatelyAbsent.includes(key)) continue;

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
