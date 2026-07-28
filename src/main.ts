import { Logger } from '@nestjs/common';
import { CorsOptionsDelegate } from '@nestjs/common/interfaces/external/cors-options.interface';
import { NestFactory } from '@nestjs/core';
import { Request } from 'express';
import { AppModule } from './app.module';
import { browserCorsPolicy } from './common/cors/browser-cors';
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

  // Decided per request rather than once at boot, because the two kinds of
  // browser caller this API serves need different answers and only one of them
  // has an origin knowable in advance. `browserCorsPolicy` carries the
  // reasoning; this delegate is the plumbing that reaches it.
  const corsDelegate: CorsOptionsDelegate<Request> = (request, callback) => {
    callback(
      null,
      browserCorsPolicy(request.headers.origin, config.webOrigins),
    );
  };

  app.enableCors(corsDelegate);

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
