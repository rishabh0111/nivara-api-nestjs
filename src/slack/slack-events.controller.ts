import {
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  RawBodyRequest,
  Req,
  Res,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { Public } from '../auth/auth.guard';
import { SlackInboundService } from './slack-inbound.service';

/**
 * The one route Slack calls, and the only unauthenticated write surface in this
 * API that is not gated by an allowlist.
 *
 * Mounted per source rather than behind a generic `/webhooks/:id` dispatcher.
 * That is the difference between a webhook product and a source adapter: a
 * dispatcher would need a registry of endpoints, per-endpoint secrets and a
 * tenant-facing surface to manage them, which build ticket 10 ruled out. Each
 * adapter is instead a route and a signature descriptor, and the second one costs
 * exactly that.
 *
 * Everything interesting is in `SlackInboundService`. What is left here is the
 * two things a controller is actually for — reading the request off the wire and
 * turning an outcome into a status — and one of those is unusual enough to be the
 * reason this class exists at all.
 *
 * `@ApiExcludeController` because there is no client for this. The OpenAPI
 * document is a contract for `nivara-web` and `nivara-ai`; Slack has never read
 * it and publishing an endpoint that only Slack may successfully call would
 * advertise an attack surface while documenting nothing anyone can use.
 */
@ApiExcludeController()
@Controller('integrations/slack')
export class SlackEventsController {
  constructor(private readonly inbound: SlackInboundService) {}

  /**
   * Takes an event, or refuses it.
   *
   * `req.rawBody` rather than `@Body()`, and that is the whole reason this
   * handler takes a request object. The signature is computed over the bytes
   * Slack sent; a parsed-and-re-encoded object has the same meaning and different
   * bytes — key order, whitespace, unicode escapes — so verifying against it
   * fails every time and fails in the way that looks exactly like a wrong secret.
   * The raw buffer is preserved by `rawBody: true` at bootstrap.
   *
   * A missing raw body is treated as an empty one rather than as an error. It
   * means the bootstrap option was lost, and the honest consequence is that
   * nothing verifies — a loud, total refusal — rather than a silent fallback to
   * the parsed body, which would verify nothing while appearing to work.
   *
   * The response is written through `@Res({ passthrough: true })` so the
   * challenge can answer with a bare string. It is the one endpoint in this API
   * that does not speak the response envelope, and it does not because it has no
   * client of ours: Slack specifies this handshake and expects its challenge
   * echoed back verbatim.
   */
  @Post('events')
  @Public()
  @HttpCode(HttpStatus.OK)
  async receive(
    @Req() request: RawBodyRequest<Request>,
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    const result = await this.inbound.accept({
      headers: request.headers,
      rawBody: request.rawBody?.toString('utf8') ?? '',
    });

    if (result.outcome === 'challenge') return result.challenge;

    // A bare 401 with an empty body, deliberately outside the error envelope
    // every other refusal in this API uses. The envelope exists to tell a client
    // of ours what went wrong so it can fix it; there is no such client here, and
    // the only reader of a detailed refusal would be someone probing the
    // endpoint. Which check failed is in the log instead.
    if (result.outcome === 'refuse') {
      response.status(HttpStatus.UNAUTHORIZED);
    }

    return '';
  }
}
