import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../auth/auth.guard';
import { LivenessDto } from './liveness.dto';

@ApiTags('health')
@Controller('health')
// Unauthenticated by necessity: the platform's health check has no credential
// to present, and a liveness probe that could fail on authentication would
// report the process dead for a reason unrelated to whether it is running.
@Public()
export class HealthController {
  private readonly startedAt = Date.now();

  /**
   * Liveness, and the keep-warm ping target.
   *
   * Deliberately touches nothing — no Postgres, no Redis. Free-tier hosting
   * sleeps an idle service, which would stop the in-process scheduler, so this
   * endpoint has to answer 200 whenever the event loop is alive. If it checked
   * dependencies, a brief database blip would read as "down", the ping would
   * fail, and the service could be allowed to sleep for a reason unrelated to
   * its own health.
   *
   * Dependency truth belongs in a separate readiness endpoint, which arrives
   * with the dependencies it would check.
   */
  @Get()
  @ApiOperation({
    summary: 'Liveness — process only, no dependencies',
    description:
      'Answers 200 whenever the process is alive. Touches neither Postgres nor Redis. This is the keep-warm ping target.',
  })
  @ApiOkResponse({ type: LivenessDto })
  liveness(): LivenessDto {
    return {
      status: 'ok',
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }
}
