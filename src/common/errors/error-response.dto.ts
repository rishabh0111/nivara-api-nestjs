import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ERROR_CODES } from './error-codes';

export class ErrorDetailDto {
  @ApiProperty({ example: 'priority' })
  field!: string;

  @ApiProperty({ example: 'must be one of low, normal, high, urgent' })
  issue!: string;
}

export class ErrorBodyDto {
  @ApiProperty({
    enum: ERROR_CODES,
    description:
      'Stable machine-readable code from the closed catalog at `GET /meta/error-codes`. Branch on this, never on `message`.',
  })
  code!: string;

  @ApiProperty({
    description:
      'Human-readable and safe to surface. Never contains internals.',
  })
  message!: string;

  @ApiPropertyOptional({
    type: [ErrorDetailDto],
    description: 'One entry per offending field. Present only on 422.',
  })
  details?: ErrorDetailDto[];
}

/**
 * The one error shape every non-2xx response takes.
 *
 * Success items are returned bare, but errors always wrap — the envelope is the
 * one place the shape is uniform, and HTTP status is the discriminator.
 */
export class ErrorResponse {
  @ApiProperty({ type: ErrorBodyDto })
  error!: ErrorBodyDto;
}
