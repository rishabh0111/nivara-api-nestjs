import { Controller, Get, Res } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Response } from 'express';
import { AppConfigService } from '../config/app-config.service';
import { Public } from '../auth/auth.guard';
import { evaluateReadiness } from '../scheduler/readiness';
import { SchedulerHeartbeat } from '../scheduler/scheduler-heartbeat';
import { TenancyService } from '../tenancy/tenancy.service';
import { LivenessDto } from './liveness.dto';
import { ReadinessDto } from './readiness.dto';

@ApiTags('health')
@Controller('health')
// Unauthenticated by necessity: the platform's health check has no credential
// to present, and a liveness probe that could fail on authentication would
// report the process dead for a reason unrelated to whether it is running.
@Public()
export class HealthController {
  private readonly startedAt = Date.now();

  constructor(
    private readonly tenancy: TenancyService,
    private readonly heartbeat: SchedulerHeartbeat,
    private readonly config: AppConfigService,
  ) {}

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

  /**
   * Readiness — the dependency truth liveness above deliberately refuses to
   * report, arriving now that there are dependencies worth checking.
   *
   * The two answer different questions and a caller must not substitute one for
   * the other. Liveness says "this process is alive, do not restart it";
   * readiness says "this process can do its job right now, send it traffic".
   * Pointing the keep-warm ping at *this* endpoint would undo the whole
   * argument in the comment above — a database blip would fail the ping and the
   * free-tier service would be allowed to sleep, which stops the ticker, which
   * is the outage this endpoint exists to report.
   *
   * The scheduler heartbeat is a dependency here alongside Postgres, because a
   * wedged ticker is invisible from every other angle: the API keeps answering
   * perfectly while every timed promise the product makes quietly stops. A
   * process in that state is exactly one that should be taken out of rotation
   * and looked at, which is what a 503 here means.
   *
   * The status code is set on the response rather than thrown as an exception.
   * A 503 here is a *report*, and the body carries which dependency is at fault
   * and how stale each tick is — throwing would replace that with an error
   * envelope, and the caller would have to guess what to look at.
   */
  @Get('ready')
  @ApiOperation({
    summary: 'Readiness — Postgres and the scheduler heartbeat',
    description:
      'Answers 200 when the database is reachable and no enabled tick has stalled, and 503 otherwise, with the offending dependency named in the body. Not the keep-warm ping target — that is `/health`.',
  })
  @ApiOkResponse({ type: ReadinessDto })
  @ApiServiceUnavailableResponse({
    type: ReadinessDto,
    description:
      'A dependency is unavailable, or a scheduler tick has stalled.',
  })
  async readiness(
    @Res({ passthrough: true }) response: Response,
  ): Promise<ReadinessDto> {
    const readiness = evaluateReadiness({
      now: new Date(),
      database: { reachable: await this.tenancy.ping() },
      scheduler: {
        // Read from configuration rather than from whether any tick registered.
        // "Switched on but never started" is a real failure — a ticker that
        // threw during bootstrap — and inferring `enabled` from the registry
        // would report exactly that case as a healthy, dormant scheduler.
        enabled: this.config.runScheduler,
        ticks: this.heartbeat.report(),
      },
    });

    if (readiness.status !== 'ok') {
      response.status(503);
    }

    return readiness;
  }
}
