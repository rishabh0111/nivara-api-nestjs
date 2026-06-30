import { ApiProperty } from '@nestjs/swagger';
import { ActorKind, Note } from '../../generated/prisma/client';

/**
 * A Note on the wire.
 *
 * The same fields as `MessageDto` and a separate class anyway. Sharing one
 * would mean one mapper accepting both rows, which is the point at which a
 * handler serializing "an entry" stops being able to tell a reviewer — or the
 * generated OpenAPI document — which kind it returns. `MessageDto` and `NoteDto`
 * appear as two schemas because they are two things, and a client generated
 * from this document cannot pass one where the other belongs.
 */
export class NoteDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ description: 'The Ticket this belongs to.' })
  ticketId!: string;

  @ApiProperty({
    description: 'The internal note, as plain text. Never shown to a Contact.',
  })
  body!: string;

  @ApiProperty({
    enum: ActorKind,
    enumName: 'ActorKind',
    description:
      'What kind of thing wrote this. In practice a User or a ServiceToken — a Contact cannot hold `note:write`. Server-stamped and not settable.',
  })
  authorKind!: ActorKind;

  @ApiProperty({
    nullable: true,
    type: String,
    format: 'uuid',
    description:
      'The author’s id, or null for `system`. Read it against `authorKind`.',
  })
  authorId!: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: string;
}

/** The one place a Note row becomes a Note response. */
export const toNoteDto = (note: Note): NoteDto => ({
  id: note.id,
  ticketId: note.ticketId,
  body: note.body,
  authorKind: note.authorKind,
  authorId: note.authorId,
  createdAt: note.createdAt.toISOString(),
});
