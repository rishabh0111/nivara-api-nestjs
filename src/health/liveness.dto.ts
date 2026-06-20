import { ApiProperty } from '@nestjs/swagger';

export class LivenessDto {
  @ApiProperty({ enum: ['ok'], example: 'ok' })
  status!: 'ok';

  @ApiProperty({
    description: 'Seconds since the process started.',
    example: 42,
  })
  uptimeSeconds!: number;
}
