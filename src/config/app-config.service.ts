import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Env } from './env.schema';

/**
 * Typed access to validated configuration.
 *
 * Nothing else in the application reads `process.env`. Going through here means
 * a key that does not exist is a compile error rather than a runtime
 * `undefined`, and it gives feature gates one place to live.
 */
@Injectable()
export class AppConfigService {
  constructor(private readonly config: ConfigService<Env, true>) {}

  get<K extends keyof Env>(key: K): Env[K] {
    return this.config.get(key, { infer: true });
  }

  get nodeEnv(): Env['NODE_ENV'] {
    return this.get('NODE_ENV');
  }

  get port(): number {
    return this.get('PORT');
  }

  /**
   * The runtime connection string — always the non-`BYPASSRLS` `app_user`.
   *
   * There is deliberately no accessor for `MIGRATE_DATABASE_URL`. The owner
   * credential belongs to the Prisma CLI, and giving the application a typed
   * way to read it would be the first step toward something using it.
   */
  get databaseUrl(): string {
    return this.get('DATABASE_URL');
  }

  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  }

  get swaggerEnabled(): boolean {
    return this.get('SWAGGER_ENABLED');
  }

  /**
   * Which optional integrations are live.
   *
   * A dormant integration is the normal state, not a degraded one: the demo
   * path runs with both of these false. Code behind a gate checks here rather
   * than testing a secret for undefined at the call site.
   */
  get features(): { google: boolean; slack: boolean } {
    return {
      google: this.get('GOOGLE_CLIENT_ID') !== undefined,
      slack: this.get('SLACK_SIGNING_SECRET') !== undefined,
    };
  }
}
