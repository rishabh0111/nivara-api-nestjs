import { ApiProperty } from '@nestjs/swagger';

/**
 * The signed-in Contact, describing itself.
 *
 * Not `PrincipalDto`. That one carries a `role`, and a Contact has none — a
 * shared class would need the field optional, and an optional role is the first
 * step toward code that reads it and finds `undefined` where it expected
 * `agent`. Two surfaces, two shapes, no field that means nothing on one of them.
 */
export class ContactPrincipalDto {
  @ApiProperty({
    enum: ['contact'],
    description:
      'Always `contact` here. The staff surface answers `user`; a client holding one kind of token cannot reach the other’s endpoint.',
  })
  kind!: 'contact';

  @ApiProperty({ format: 'uuid' })
  contactId!: string;

  @ApiProperty({ format: 'uuid' })
  tenantId!: string;

  @ApiProperty({
    format: 'email',
    nullable: true,
    type: String,
    description:
      'Null for a Contact that has never been identified — a widget visitor, say. A Contact that can sign in here necessarily has one.',
  })
  email!: string | null;

  @ApiProperty({ nullable: true, type: String })
  name!: string | null;

  @ApiProperty({
    description:
      'Whether this Contact’s identity has been confirmed, as opposed to inferred from an anonymous session.',
  })
  verified!: boolean;
}
