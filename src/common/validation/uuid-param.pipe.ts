import { ParseUUIDPipe } from '@nestjs/common';
import { AppException } from '../errors/app-exception';

/**
 * The pipe every `:id` path parameter binds through.
 *
 * Without it a malformed id reaches Prisma and then Postgres, which does not
 * quietly fail to match a bad `uuid` — it raises a type error. That arrives as
 * an unhandled exception and leaves as a 500, so `GET /tickets/not-a-uuid`
 * reports the client's typo as a server fault.
 *
 * The refusal is `malformed_request` rather than `not_found`, and that is not
 * a hole in the "another tenant's row is indistinguishable from a missing one"
 * rule. That rule exists to stop existence being probed — but no row's id can
 * be a non-uuid, so this answer describes the *shape* of the request and
 * discloses nothing about what exists. A caller who sends a well-formed id
 * still cannot tell a foreign row from an absent one.
 *
 * Shared as one configured instance rather than constructed per route: pipes
 * are stateless, and three routes each spelling out their own exception
 * factory is three chances for one of them to answer differently.
 */
export const UuidParam = new ParseUUIDPipe({
  exceptionFactory: () =>
    new AppException(
      'malformed_request',
      'The id in the path is not a valid uuid.',
    ),
});
