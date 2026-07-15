import { INestApplication, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from 'src/app.module';
import { GLOBAL_PROVIDERS } from 'src/common/global-providers';
import { AppConfigModule } from 'src/config/app-config.module';
import { IdempotencyModule } from 'src/idempotency/idempotency.module';
import { TenancyModule } from 'src/tenancy/tenancy.module';
import { setupOpenApi } from 'src/openapi/document';

interface BootOptions {
  /** Mount the OpenAPI routes, as `main.ts` does when Swagger is enabled. */
  openApi?: boolean;

  /**
   * Providers to replace in the real graph, keyed by their class token.
   *
   * For network seams and nothing else. The value of these tests is that they
   * run the real application against a real database, so anything replaced here
   * is a claim that the thing being replaced sits on the far side of a boundary
   * this suite cannot own — a third party's HTTP API. Replacing a service to
   * make an assertion easier would hollow out the suite instead.
   */
  overrides?: { provide: Type<unknown>; useValue: unknown }[];
}

/**
 * Boots the real application, exactly as `main.ts` does.
 *
 * Binds an ephemeral port rather than only calling `init()`, so tests drive a
 * genuinely listening server — concurrent requests against a non-listening app
 * each spin up their own throwaway listener and race.
 */
export const bootApp = async (
  options: BootOptions = {},
): Promise<INestApplication> => {
  const builder = Test.createTestingModule({ imports: [AppModule] });

  for (const { provide, useValue } of options.overrides ?? []) {
    builder.overrideProvider(provide).useValue(useValue);
  }

  const moduleRef = await builder.compile();

  // `rawBody` exactly as `main.ts` sets it. Without it the Slack ingestion tests
  // would exercise a signature check against an empty body and pass or fail for
  // reasons having nothing to do with the code under test.
  const app = moduleRef.createNestApplication({ rawBody: true });

  // Swagger mounts its routes on the adapter, so it has to run before the
  // server starts listening — the same ordering `main.ts` uses.
  if (options.openApi) setupOpenApi(app);

  await app.listen(0);

  return app;
};

/**
 * Boots a fresh copy of the application under the current environment.
 *
 * `ConfigModule.forRoot()` reads and validates the environment when the module
 * file is *evaluated*, not when the application is instantiated. Without
 * resetting the module registry, a second boot in the same process silently
 * reuses the first boot's configuration — which would make every
 * configuration-tolerance test pass vacuously.
 */
export const bootAppUnderCurrentEnv = async (): Promise<INestApplication> => {
  jest.resetModules();

  /* eslint-disable @typescript-eslint/no-require-imports */
  const { Test: FreshTest } =
    require('@nestjs/testing') as typeof import('@nestjs/testing');
  const { AppModule: FreshAppModule } =
    require('src/app.module') as typeof import('src/app.module');
  /* eslint-enable @typescript-eslint/no-require-imports */

  const moduleRef = await FreshTest.createTestingModule({
    imports: [FreshAppModule],
  }).compile();

  const app = moduleRef.createNestApplication({ rawBody: true });
  await app.listen(0);

  return app;
};

/**
 * Boots a minimal application carrying the real application's global
 * providers, plus the given test controllers.
 *
 * The globals come from the same exported list `AppModule` uses, so a
 * convention asserted against a fixture is exactly the convention a real
 * resource gets — not a copy that can drift.
 *
 * `TenancyModule` and `IdempotencyModule` are imported because one of those
 * globals — the idempotency interceptor — has real dependencies. Stubbing them
 * would be the wrong repair: the point of this helper is that a fixture meets
 * the production conventions, and a fixture meeting a hollowed-out copy of one
 * of them would assert nothing.
 */
export const bootWithControllers = async (
  ...controllers: Type<unknown>[]
): Promise<INestApplication> => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppConfigModule, TenancyModule, IdempotencyModule],
    controllers,
    providers: [...GLOBAL_PROVIDERS],
  }).compile();

  const app = moduleRef.createNestApplication();
  await app.listen(0);

  return app;
};
