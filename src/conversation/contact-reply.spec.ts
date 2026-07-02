import { TicketState } from '../generated/prisma/client';
import { replyOutcomeFor } from './contact-reply';

/**
 * The one branch in the reply path, tested where it is decidable.
 *
 * Everything else about a Contact's reply — that the reopen is a legal
 * transition, that the spawned Ticket is born `open` and `normal`, that a chain
 * holds at most one live Ticket — is enforced by the database and proved in
 * `test/ticket-linkage.int-spec.ts`, because those are claims about Postgres
 * rather than about this function. What is left here is the mapping itself, and
 * it is worth its own file: it is the piece a reader has to be able to check
 * against the ticket's prose without booting anything.
 */
describe('replyOutcomeFor', () => {
  it('appends to a Ticket that is already live', () => {
    expect(replyOutcomeFor(TicketState.open)).toBe('append');
  });

  it('reopens a Ticket that was waiting on the customer', () => {
    expect(replyOutcomeFor(TicketState.pending)).toBe('reopen');
  });

  it('reopens a Ticket the agent considered resolved', () => {
    expect(replyOutcomeFor(TicketState.resolved)).toBe('reopen');
  });

  it('spawns a linked Ticket rather than reviving a closed one', () => {
    expect(replyOutcomeFor(TicketState.closed)).toBe('spawn');
  });

  /**
   * The asymmetry between `on_hold` and `pending` is the one judgement call in
   * the table, so it is asserted rather than left to the reader.
   *
   * `pending` means "waiting on the customer" — the reply is exactly the thing
   * it was waiting for, so it ends. `on_hold` means "waiting on something else",
   * usually a third party or a deploy, and a customer chasing it does not make
   * that dependency resolve. Reopening there would report progress that has not
   * happened, and would move the Ticket out from under the agent who parked it.
   */
  it('leaves a Ticket parked on an external dependency parked', () => {
    expect(replyOutcomeFor(TicketState.on_hold)).toBe('append');
  });
});
