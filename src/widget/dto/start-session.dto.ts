import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

/**
 * Starting an anonymous widget session.
 *
 * One field, and the reasoning about it is the whole security story of a public
 * endpoint. `tenantId` is a **routing input, not an authority claim**: naming a
 * tenant decides whose allowlist the `Origin` header is checked against, and
 * getting a session still requires passing that check. It is the same shape
 * portal sign-in uses, where naming a tenant decides which `contact` rows the
 * lookup may see and seeing them still requires the password.
 *
 * From the moment a token is minted, the tenant comes from the token and never
 * from a request again — which is what makes "a session signed for one tenant
 * cannot act on another" true rather than merely intended.
 *
 * Everything else a visitor might want to declare is absent, and stays absent:
 * there is no name, no email, and no `contactId`. A widget session resolves to
 * a Contact the server creates, and nothing about the visitor is stored until
 * they do something that needs one.
 */
export class StartWidgetSessionDto {
  @ApiProperty({
    description:
      'Which tenant’s widget this is. Public — it is embedded in the widget snippet on the tenant’s own site — and it grants nothing on its own: the request is refused unless the `Origin` header is on that tenant’s allowlist.',
    format: 'uuid',
  })
  @IsUUID()
  tenantId!: string;
}
