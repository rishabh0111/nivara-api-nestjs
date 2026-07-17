import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppConfigService } from './app-config.service';
import { validateEnv } from './env.schema';

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // `.env` is gitignored and optional — the deployed environment injects
      // real values, and compose bakes in throwaway dev defaults.
      envFilePath: ['.env'],
      // Under test the environment is composed by `test/setup-env.ts`, which
      // loads `.env` itself and then adjusts it. Re-reading the file here would
      // undo those adjustments — a variable deleted to assert that the
      // application tolerates its absence would be silently restored from the
      // developer's own file, and every configuration-tolerance test would pass
      // for a reason that differs from machine to machine. Reading
      // `process.env` directly is the one place it is unavoidable: this is the
      // module that decides where configuration comes from.
      ignoreEnvFile: process.env['NODE_ENV'] === 'test',
      validate: validateEnv,
    }),
  ],
  providers: [AppConfigService],
  exports: [AppConfigService],
})
export class AppConfigModule {}
