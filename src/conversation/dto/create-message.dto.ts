import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';
import { MAX_BODY_LENGTH } from '../thread';

/**
 * Posting a Message.
 *
 * One field, and conspicuously no author. Who wrote this is stamped from the
 * credential that armed the transaction, so there is nothing here for a caller
 * to assert and nothing for the service to have to disbelieve.
 */
export class CreateMessageDto {
  @ApiProperty({
    description:
      'What to say, as plain text. Rendering is the client’s business — markup is stored verbatim, not interpreted.',
    minLength: 1,
    maxLength: MAX_BODY_LENGTH,
  })
  @IsString()
  @Length(1, MAX_BODY_LENGTH)
  body!: string;
}
