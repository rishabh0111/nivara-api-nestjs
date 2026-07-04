import { ApiProperty } from '@nestjs/swagger';

/** One grantable permission, with the description the catalog already carries. */
export class AssignableScopeDto {
  @ApiProperty({ example: 'ticket:reply' })
  scope!: string;

  @ApiProperty({ example: 'Post a customer-visible Message on a Ticket.' })
  description!: string;
}

/**
 * The assignable scope list, published so tooling does not hardcode it.
 *
 * The point of the endpoint: a downstream repo building a token-minting UI, or
 * an operator writing a provisioning script, should read what may be granted
 * rather than keep a copy that goes stale the next time the catalog moves. The
 * descriptions come straight from `PERMISSION_CATALOG`, so the list and the
 * words explaining it cannot drift apart.
 */
export class AssignableScopesDto {
  @ApiProperty({ type: [AssignableScopeDto] })
  scopes!: AssignableScopeDto[];
}
