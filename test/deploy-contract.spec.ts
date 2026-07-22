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
 * ### What this file can no longer see
 *
 * The deployed service is created by hand in a platform dashboard, so its
 * settings live in no file and nothing here can read them. Four things that
 * were once asserted are now the runbook's to state and an operator's to set:
 * the health check path, that automatic deploys stay off, that every key the
 * schema reads is present, and that no value is a literal secret. That is the
 * real cost of configuring a deployment by hand, and it is written down rather
 * than quietly absorbed — see `docs/deployment-runbook.md`, which carries them
 * as a checklist because a checklist is what is left once a test cannot help.
 *
 * What survives here is everything expressible in the repository itself, which
 * is still the whole of the role split: the credential is a CI secret, the
 * entrypoint strips it, and the application refuses to boot holding one.
 */

const root = join(__dirname, '..');
const read = (name: string) => readFileSync(join(root, name), 'utf8');

const dockerfile = read('Dockerfile');
const compose = read('docker-compose.yml');
const envExample = read('.env.example');
const gitignore = read('.gitignore');
const releaseWorkflow = read('.github/workflows/release.yml');

/** The owner role's connection string — the credential that bypasses RLS. */
const OWNER_CREDENTIAL = 'MIGRATE_DATABASE_URL';

/**
 * Every key the application reads, from the schema that reads them.
 *
 * Derived rather than listed, so the "is this key documented" test below cannot
 * pass by being out of date with the thing it checks.
 */
const CONFIGURED_KEYS = Object.keys(envSchema._def.schema.shape);

/**
 * The release workflow, parsed rather than grepped.
 *
 * Everything else here compares strings, and says why. The workflow is the
 * exception because what its assertions turn on is *shape* — which job is
 * guarded on which other job's output — and a regex over two jobs' worth of
 * YAML would be matching text that happens to sit near the thing it means to
 * check. Once parsed, the step assertion reads from the same tree, since a
 * whole-file regex for step names could not tell the two jobs apart.
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

/** The job that applies the migrations. */
const release = workflow.jobs['release'];

/** The gate's shell — the only step in it that runs anything. */
const check = gate?.steps.find((step) => step.run)?.run ?? '';

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

    it('migrates and stops, leaving the deploy to a person', () => {
      // The ordering is imposed by the release job doing strictly less than it
      // could: it applies the schema and ends, and the deploy is a deliberate
      // manual act afterwards. Nothing races because nothing here can deploy.
      //
      // Asserted as the *whole* list rather than as a membership check, because
      // the failure this guards against is a step being appended — a deploy
      // hook re-added here would deploy on every green migration, which is
      // precisely the automatic deploy that was taken out.
      const steps = release.steps
        .map((step) => step.name)
        .filter((name) => name !== undefined);

      expect(steps).toEqual(['Apply migrations']);
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
    it('gates the migration on the secret existing', () => {
      // Structural, and it has to be: the guarantee is that *nothing*
      // effectful can run ahead of the check, which is a property of the job
      // graph rather than of any step. The `secrets` context is unavailable in
      // an `if:`, so the check has to be a job that reads it and reports.
      expect(Object.keys(gate.outputs ?? {})).toEqual(['configured']);
      expect([release.needs].flat()).toContain('configured');
      expect(release.if).toContain('needs.configured.outputs.configured');

      // And nothing gates the gate, or the check could not run to say no.
      expect(gate.if).toBeUndefined();
    });

    it('decides on the secret it actually needs', () => {
      // Read into the step's environment rather than interpolated into the
      // script: an expression expanded into shell would put a connection
      // string in the command line, and a secret with a quote in it would be a
      // syntax error at best.
      const supplied = Object.values(gate.steps[0].env ?? {}).join(' ');

      expect(supplied).toContain(`secrets.${OWNER_CREDENTIAL}`);
    });

    /**
     * Both outcomes, read off the script rather than run.
     *
     * Shallow, and deliberately: executing it would make the suite depend on a
     * POSIX shell being present, which is a new requirement on a developer's
     * machine for four lines of `if`. What that costs is guarded against
     * below — each case pins the *condition* it fires under and not merely the
     * presence of a line, because "contains `configured=false`" is satisfied by
     * a script that never says true and quietly disables every migration
     * forever.
     */
    it('migrates when the secret is present', () => {
      expect(check).toMatch(
        /if \[ -n "\$MIGRATE" \]; then\s+echo 'configured=true'/,
      );
    });

    it('skips quietly when it is not', () => {
      expect(check).toMatch(/else\s+echo 'configured=false'/);
      expect(check).toContain('::notice::');
    });
  });

  describe('the two database roles', () => {
    it('keeps the owner credential to the release step alone', () => {
      // The primary mechanism, and the strongest form the guarantee takes: the
      // credential belongs to the release step, which runs in CI and holds it
      // as a secret there. The deployed service cannot bypass row-level
      // security because there is nothing in its environment to bypass it with.
      //
      // Only half of this is checkable now. That the workflow holds the
      // credential is asserted here; that the service does not is a dashboard
      // full of variables no test can read, which is why the two belts below
      // matter more than they used to rather than less.
      expect(releaseWorkflow).toContain(OWNER_CREDENTIAL);
    });

    it('strips it from the process anyway, in case somebody adds it', () => {
      // Second belt, and now the first line of defence in practice. A variable
      // added in the platform's dashboard appears in no file this test can
      // read, so the entrypoint is what holds — `node` is `exec`d with an
      // environment that never contained it.
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
      // anyone deploying this will read — and with no blueprint in the
      // repository it is now the *only* list of what a deployment must be
      // given. A key added to the schema and not to the file is invisible
      // until something fails to start.
      const documented = new Set(
        [...envExample.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map(([, key]) => key),
      );

      for (const key of CONFIGURED_KEYS) {
        expect([key, documented.has(key)]).toEqual([key, true]);
      }
    });

    it('keeps the real .env out of the repository', () => {
      expect(gitignore).toMatch(/^\.env$/m);
    });

    it('commits no platform blueprint that could carry a credential', () => {
      // The deployment is configured by hand, which is a choice with a cost —
      // see this file's opening note. This is the compensating benefit, and
      // asserting it keeps the trade honest: with no blueprint there is no file
      // in git that a connection string can be pasted into, and the class of
      // mistake where a credential is committed to a public repository as
      // "configuration" cannot happen here.
      expect(() => read('render.yaml')).toThrow();
    });
  });

  describe('the scheduler split', () => {
    it('is a flag in the deployment, not a branch in the code', () => {
      // Moving the ticker to its own always-on service means setting this to
      // false on the web service and adding a second service with it true. The
      // claim that it is a deploy change rather than a rewrite is only true
      // while the flag is the whole of the mechanism.
      expect(envExample).toMatch(/^RUN_SCHEDULER=/m);
    });
  });

  describe('health', () => {
    it('points the compose health check at liveness, never readiness', () => {
      // Failing this check restarts the instance, and readiness reports
      // conditions that are not reasons to restart — a database blip resolves
      // itself, and a restart during one kills the process that would have
      // recovered.
      //
      // The deployed health check is a dashboard field now, so compose is the
      // only place this is still enforceable. It is also the place a reader
      // looks to find out what the deployed one should say, which is why the
      // runbook quotes this path rather than inventing one.
      expect(compose).toContain('localhost:3000/health');
      expect(compose).not.toContain('localhost:3000/health/ready');
    });
  });
});
