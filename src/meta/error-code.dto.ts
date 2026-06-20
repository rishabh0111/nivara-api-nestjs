import { ApiProperty } from '@nestjs/swagger';
import { ERROR_CODES } from 'src/common/errors/error-codes';

export class ErrorCodeDto {
  @ApiProperty({
    enum: ERROR_CODES,
    description: 'The stable `snake_case` code clients branch on.',
  })
  code!: string;

  @ApiProperty({
    description: 'The HTTP status this code is always returned with.',
    example: 404,
  })
  status!: number;

  @ApiProperty({ description: 'What this code means and when it is emitted.' })
  description!: string;
}
