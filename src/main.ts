import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AppConfigService } from './config/app-config.service';
import { OPENAPI_PATH, setupOpenApi } from './openapi/document';

async function bootstrap(): Promise<void> {
  // `rawBody` keeps the bytes of every request beside the parsed body, and it is
  // switched on here rather than per-route because the body parser runs before
  // any route is chosen. Exactly one handler reads it — the Slack ingestion
  // endpoint, whose signature covers the bytes Slack sent rather than the object
  // they parse into — and a re-encoded body would fail to verify in the way that
  // looks precisely like a wrong secret.
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });
  const config = app.get(AppConfigService);
  const logger = new Logger('Bootstrap');

  app.enableShutdownHooks();

  if (config.swaggerEnabled) {
    setupOpenApi(app);
  }

  await app.listen(config.port, '0.0.0.0');

  const { google, slack } = config.features;

  logger.log(`Listening on port ${config.port} (${config.nodeEnv})`);
  logger.log(
    `Optional integrations — Google: ${google ? 'configured' : 'dormant'}, Slack: ${slack ? 'configured' : 'dormant'}`,
  );

  if (config.swaggerEnabled) {
    logger.log(`OpenAPI document at /${OPENAPI_PATH}`);
  }
}

void bootstrap();
