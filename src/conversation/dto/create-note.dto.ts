import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';
import { MAX_BODY_LENGTH } from '../thread';

/** Writing a Note. One field, and no author — see `CreateMessageDto`. */
export class CreateNoteDto {
  @ApiProperty({
    description:
      'The internal note, as plain text. Never delivered to a Contact by any endpoint.',
    minLength: 1,
    maxLength: MAX_BODY_LENGTH,
  })
  @IsString()
  @Length(1, MAX_BODY_LENGTH)
  body!: string;
}
