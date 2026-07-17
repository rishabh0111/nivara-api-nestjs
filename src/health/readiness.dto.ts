import { ApiProperty } from '@nestjs/swagger';
import {
  DatabaseHealth,
  Readiness,
  RedisHealth,
  SchedulerHealth,
  TickHealth,
} from '../scheduler/readiness';

/**
 * The published shape of the readiness verdict.
 *
 * Every class here `implements` its counterpart in `scheduler/readiness.ts`
 * rather than restating it. The two would otherwise be free to drift: a field
 * added to the verdict and forgotten here still compiles, and the only symptom
 * would be an OpenAPI document quietly describing a response the service no
 * longer sends. The `implements` clause makes that a compile error.
 *
 * They stay separate types because they answer to different masters — the
 * verdict is pure logic with no framework in it, and these carry the decorators
 * that generate the document.
 */
class DependencyDto implements DatabaseHealth {
  @ApiProperty({ enum: ['ok', 'unavailable'], example: 'ok' })
  status!: 'ok' | 'unavailable';
}

class RedisDto implements RedisHealth {
  @ApiProperty({
    enum: ['ok', 'degraded', 'dormant'],
    description:
      'Neither `degraded` nor `dormant` fails the check. `dormant` means REDIS_URL is unset, which is a supported configuration; `degraded` means it is set and not answering. Both mean no rate-limit ceilings are being enforced, and every request is still served correctly.',
    example: 'ok',
  })
  status!: 'ok' | 'degraded' | 'dormant';
}

class TickDto implements TickHealth {
  @ApiProperty({ example: 'fast-drain' })
  name!: string;

  @ApiProperty({ enum: ['ok', 'stalled'], example: 'ok' })
  status!: 'ok' | 'stalled';

  @ApiProperty({
    nullable: true,
    description: 'Null when the ticker has been started but has never fired.',
    example: '2026-07-19T12:00:00.000Z',
  })
  lastTickAt!: string | null;

  @ApiProperty({
    nullable: true,
    description: 'Seconds since the last tick. Null when there has been none.',
    example: 1.4,
  })
  ageSeconds!: number | null;
}

class SchedulerDto implements SchedulerHealth {
  @ApiProperty({
    enum: ['ok', 'stalled', 'disabled'],
    description:
      '`disabled` is healthy — it means RUN_SCHEDULER put no ticker in this process, which is the normal state for a web instance once the scheduler moves to its own service.',
    example: 'ok',
  })
  status!: 'ok' | 'stalled' | 'disabled';

  @ApiProperty({ type: [TickDto] })
  ticks!: TickDto[];
}

export class ReadinessDto implements Readiness {
  @ApiProperty({ enum: ['ok', 'unavailable'], example: 'ok' })
  status!: 'ok' | 'unavailable';

  @ApiProperty({ type: DependencyDto })
  database!: DependencyDto;

  @ApiProperty({ type: RedisDto })
  redis!: RedisDto;

  @ApiProperty({ type: SchedulerDto })
  scheduler!: SchedulerDto;
}
