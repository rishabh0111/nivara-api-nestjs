import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from 'src/app.module';
import { buildOpenApiDocument } from './document';

/**
 * Writes the OpenAPI document to disk without starting a server.
 *
 * `nivara-web` and `nivara-ai` generate clients from this document. The file is
 * a build artifact rather than a checked-in one — it is regenerated from the
 * code on demand, so it cannot go stale the way a hand-maintained spec does.
 */
async function emit(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false });
  await app.init();

  const target = resolve(process.cwd(), 'openapi.json');
  writeFileSync(target, JSON.stringify(buildOpenApiDocument(app), null, 2));

  await app.close();

  process.stdout.write(`Wrote ${target}\n`);
}

void emit();
