import { INestApplication, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AppModule } from 'src/app.module';
import { GLOBAL_PROVIDERS } from 'src/common/global-providers';
import { AppConfigModule } from 'src/config/app-config.module';
import { setupOpenApi } from 'src/openapi/document';

interface BootOptions {
  /** Mount the OpenAPI routes, as `main.ts` does when Swagger is enabled. */
  openApi?: boolean;
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
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication();

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

  const app = moduleRef.createNestApplication();
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
 */
export const bootWithControllers = async (
  ...controllers: Type<unknown>[]
): Promise<INestApplication> => {
  const moduleRef = await Test.createTestingModule({
    imports: [AppConfigModule],
    controllers,
    providers: [...GLOBAL_PROVIDERS],
  }).compile();

  const app = moduleRef.createNestApplication();
  await app.listen(0);

  return app;
};
