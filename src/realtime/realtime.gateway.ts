import { Logger } from '@nestjs/common';
import { ErrorCode } from '../common/errors/error-codes';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Namespace, Socket } from 'socket.io';
import { AccessTokenService } from '../auth/access-token.service';
import { tenantContextFor } from '../auth/request-principal';
import { isServiceToken } from '../service-tokens/service-token-format';
import { TenancyService } from '../tenancy/tenancy.service';
import { isWidgetToken } from '../widget/widget-session-token';
import { WidgetSessionService } from '../widget/widget-session.service';
import { canJoin } from './can-join';
import { EventLog } from './event-log';
import { canReceive, RealtimeEnvelope } from './events';
import { RealtimePrincipal, realtimePrincipalOf } from './realtime-principal';
import { parseRoom } from './rooms';
import { parseRoomName, parseSubscribe } from './subscribe-request';

/**
 * The namespace every real-time connection lands on.
 *
 * One namespace rather than one per tenant, deliberately. A namespace per tenant
 * would put the tenant in the *connection URL*, which is client-supplied — the
 * exact input this surface refuses to take a tenant from. Rooms carry the tenant
 * instead, and the token decides which of them the socket may enter.
 */
export const REALTIME_NAMESPACE = 'rt';

/**
 * What a `subscribe` is answered with.
 *
 * The failure arm is narrowed from `ErrorCode` rather than spelled out as
 * string literals, so the socket's refusals are drawn from the same closed
 * catalog the HTTP surface serves at `GET /meta/error-codes`. A client handles
 * one vocabulary across both surfaces, and a rename in the catalog breaks this
 * file at compile time instead of silently diverging from it.
 */
export type SubscribeAck =
  | { ok: true; room: string; replayed: number; gap: boolean }
  | { ok: false; error: Extract<ErrorCode, 'malformed_request' | 'forbidden'> };

/** What an `unsubscribe` is answered with. */
export type UnsubscribeAck = { ok: true; room: string };

/**
 * What a refused handshake tells the client, as `connect_error`'s message.
 *
 * The same word the HTTP catalog uses for the same fact, so a client handles one
 * concept across both surfaces rather than learning a socket-specific vocabulary
 * for "your credential did not work".
 */
export const UNAUTHENTICATED = 'unauthenticated';

/** Where the connection's principal lives, once the handshake has fixed it. */
interface SocketData {
  principal?: RealtimePrincipal;
}

/**
 * The socket surface: connect, subscribe, and delivery.
 *
 * Three properties are worth stating together, because they are what make a
 * long-lived connection as safe as a request that re-authenticates every time.
 *
 * **The principal is fixed at connect, from the token, and never revisited.** A
 * client cannot declare who it is — there is no field anywhere in this file read
 * from a message that contributes to identity — and the tenant it acts in comes
 * from a signed claim. The consequence to be honest about is the other side of
 * that coin: authority is a snapshot taken at connect, so a role change or a
 * revoked widget session takes effect on the next *connection*, not the next
 * frame. That is bounded by the token lifetimes (fifteen minutes for staff,
 * thirty for a widget) and by the fact that a socket only ever reads.
 *
 * **Authorization is a room gate, not a row gate.** `canJoin` decides membership;
 * row-level security decides what the reads behind it return. The one place they
 * meet is the requester check below, and it is resolved by *asking the database
 * under the principal's own context* rather than by comparing ids here — so the
 * socket has no second copy of the ownership rule to drift from the policy.
 *
 * **Delivery is filtered per socket, not per room.** Broadcasting to a room and
 * trusting membership would make the room the only Note barrier; fetching the
 * room's sockets and asking `canReceive` of each is the second one, and it is
 * what turns a mis-routed emit into a delivery to nobody.
 */
@WebSocketGateway({
  namespace: REALTIME_NAMESPACE,
  // Permissive by necessity and safe by construction: the widget runs on each
  // tenant's own site, so the set of legitimate origins is per-tenant data this
  // handshake has not read yet — the token that would tell it which tenant is
  // the thing being verified. It is safe because nothing here is authenticated
  // by ambient credentials: there is no cookie and no session, only a bearer
  // token a hostile page cannot obtain by being loaded. The per-tenant origin
  // allowlist still gates *minting* that token, which is where it belongs.
  cors: { origin: true, credentials: false },
})
export class RealtimeGateway implements OnGatewayInit {
  private readonly logger = new Logger(RealtimeGateway.name);

  @WebSocketServer()
  private readonly namespace!: Namespace;

  constructor(
    private readonly accessTokens: AccessTokenService,
    private readonly widgetSessions: WidgetSessionService,
    private readonly tenancy: TenancyService,
    private readonly log: EventLog,
  ) {}

  /**
   * Installs authentication *in front of* the connection, not after it.
   *
   * This is a namespace middleware rather than a `handleConnection` hook, and
   * the difference is not stylistic. A connection handler runs once the client
   * already believes it is connected, so refusing there means connecting a
   * socket and then hanging up on it — the client sees `connect` followed by
   * `disconnect` and has to work out that the second was about the first.
   * Refusing here fails the handshake itself: the client gets `connect_error`,
   * never enters a connected state, and there is no window in which an
   * unauthenticated socket exists on this server at all.
   *
   * It also removes a whole class of mistake. There is no moment between
   * `connection` and the principal being set, so a message handler that forgot
   * to check for one could not be reached by an anonymous socket.
   *
   * The token is read from the Socket.IO `auth` payload rather than a header,
   * because that is the one channel a browser client controls on a WebSocket
   * upgrade — `Authorization` cannot be set on the native handshake at all. It
   * is accepted from the query string nowhere, deliberately: query strings are
   * logged by every proxy in the path.
   */
  afterInit(namespace: Namespace): void {
    namespace.use((socket, next) => {
      void this.authenticate(socket).then(
        (principal) => {
          if (!principal) {
            // The same single answer every credential failure gets on the HTTP
            // surface: no token, a bad one, an expired one, a revoked widget
            // session and a service token are one fact to the client — this
            // connection is not authenticated. The reason is never given,
            // because telling them apart would describe the server's key
            // material to whoever is probing it.
            next(new Error(UNAUTHENTICATED));

            return;
          }

          (socket.data as SocketData).principal = principal;
          next();
        },
        (error: unknown) => {
          // A verifier that threw rather than answering `null` — a database
          // that is down behind the widget session lookup, say. Refused with
          // the same message, and logged here because it is the one failure in
          // this path that is the server's fault rather than the client's.
          this.logger.error('Handshake verification failed', error);
          next(new Error(UNAUTHENTICATED));
        },
      );
    });
  }

  /**
   * Joins a room, then replays what this principal missed in it.
   *
   * The order is join-then-replay, and it is the safe one of the two. Replaying
   * first would leave a window between the last replayed event and the join
   * during which a live event lands in the room this socket has not entered yet
   * — a permanently missed event, which no amount of client-side dedupe can
   * recover. Joining first can only produce the opposite: an event delivered
   * live *and* in the replay, which is precisely the duplicate the at-least-once
   * contract tells the client to discard on `(room, seq)`.
   */
  @SubscribeMessage('subscribe')
  async subscribe(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ): Promise<SubscribeAck> {
    const principal = (socket.data as SocketData).principal;

    if (!principal) return { ok: false, error: 'forbidden' };

    const request = parseSubscribe(body);

    if (!request) return { ok: false, error: 'malformed_request' };

    if (!(await this.mayJoin(principal, request.room))) {
      return { ok: false, error: 'forbidden' };
    }

    await socket.join(request.room);

    const { events, gap } = this.log.replay(
      principal,
      request.room,
      request.afterSeq,
    );

    for (const envelope of events) socket.emit(envelope.event, envelope);

    return { ok: true, room: request.room, replayed: events.length, gap };
  }

  /**
   * Leaves a room.
   *
   * Unconditionally acknowledged, including for a room the socket was never in
   * and for a name that is not a room at all. There is nothing to authorize —
   * leaving is not a capability — and answering differently would turn this into
   * a probe that reports whether a subscribe had succeeded.
   */
  @SubscribeMessage('unsubscribe')
  async unsubscribe(
    @ConnectedSocket() socket: Socket,
    @MessageBody() body: unknown,
  ): Promise<UnsubscribeAck> {
    // `parseRoomName`, not `parseSubscribe`: a cursor is meaningless on a leave,
    // and running the stricter parse here meant a client that sent a malformed
    // one was acknowledged without actually leaving the room.
    const room = parseRoomName(body) ?? '';

    if (room) await socket.leave(room);

    return { ok: true, room };
  }

  /**
   * Hands an envelope to every socket in its room that may receive it.
   *
   * Per-socket rather than `namespace.to(room).emit(...)`, which is the whole
   * second Note barrier. A room broadcast would deliver whatever the emitter
   * routed, so a Note emitted at the customer-visible thread room by mistake
   * would reach the customer; here that same mistake reaches nobody, because
   * every recipient is asked `canReceive` on the way out.
   *
   * Failures are logged rather than thrown. This is called from the tail of a
   * committed write, so raising here would turn a successful state change into
   * a failed request — and the client's own reconnect-and-replay path already
   * covers an event that did not arrive.
   */
  async deliver(envelope: RealtimeEnvelope): Promise<void> {
    // Nothing to deliver to before the gateway has been initialized — a write
    // during boot, or a unit test holding this class without a server. Declared
    // non-null because Nest always sets it in practice; checked anyway, because
    // the alternative to a guard here is a boot-order crash on a path whose
    // whole contract is that it cannot fail the write behind it.
    if (!this.namespace) return;

    try {
      const sockets = await this.namespace.in(envelope.room).fetchSockets();

      for (const socket of sockets) {
        const principal = (socket.data as SocketData).principal;

        if (principal && canReceive(principal, envelope.event)) {
          socket.emit(envelope.event, envelope);
        }
      }
    } catch (error) {
      this.logger.error(
        `Failed to deliver ${envelope.event} to ${envelope.room}`,
        error,
      );
    }
  }

  /**
   * The presented credential, reduced to a principal this surface admits.
   *
   * The same prefix routing `AuthGuard` does, against the same two verifiers, so
   * a token means the same thing on both surfaces. Service tokens are refused
   * explicitly rather than left to fail at `AccessTokenService.verify` — they
   * would, since `nvk_live_…` is not a JWT — because "machines do not hold
   * sockets" is a decision, and a decision that survives only as a side effect
   * of a parse failure is one nobody can find later.
   */
  private async authenticate(
    socket: Socket,
  ): Promise<RealtimePrincipal | null> {
    const token = handshakeToken(socket);

    if (!token) return null;
    if (isServiceToken(token)) return null;

    const principal = isWidgetToken(token)
      ? await this.widgetSessions.verify(token)
      : await this.accessTokens.verify(token);

    return principal ? realtimePrincipalOf(principal) : null;
  }

  /**
   * `canJoin`, with the one verdict it cannot answer alone resolved.
   *
   * The requester check is a read against the Ticket under the *principal's own*
   * tenant context, so the answer comes from the contact-axis policy rather than
   * from a comparison written here. That is deliberate to the point of being the
   * design: `contactId === ticket.contactId` in this file would be a second
   * implementation of row ownership, correct today and free to drift the moment
   * the policy learns about, say, a Ticket shared across a chain.
   *
   * A widget visitor with no Contact yet resolves through
   * `existingContactPrincipal`, which does not create one. A read must not leave
   * a durable row behind, and a socket subscribe is a read — a visitor who has
   * said nothing owns no Tickets, and finding that out must not be what makes
   * them a Contact.
   */
  private async mayJoin(
    principal: RealtimePrincipal,
    roomName: string,
  ): Promise<boolean> {
    const verdict = canJoin(principal, roomName);

    if (verdict !== 'requires-requester-match') return verdict === 'allow';

    const room = parseRoom(roomName);

    // Unreachable: the verdict is only returned for a parsed ticket room. Kept
    // as a refusal rather than an assertion, so a future change that made it
    // reachable would close a socket rather than crash one.
    if (!room || room.kind !== 'ticket') return false;

    const contact =
      principal.kind === 'widget'
        ? this.widgetSessions.existingContactPrincipal(principal)
        : principal;

    if (!contact) return false;

    const ticket = await this.tenancy.withTenant(
      tenantContextFor(contact),
      (tx) => tx.ticket.findUnique({ where: { id: room.ticketId } }),
    );

    return ticket !== null;
  }
}

/**
 * The bearer value off a handshake.
 *
 * `auth.token` is the Socket.IO idiom and the only place this reads. Accepting
 * one from `handshake.query` as a fallback would be convenient and would put
 * credentials into every access log between here and the client.
 */
const handshakeToken = (socket: Socket): string | null => {
  const auth = socket.handshake.auth as Record<string, unknown> | undefined;
  const token = auth?.token;

  if (typeof token !== 'string') return null;

  const value = token.trim();

  return value === '' ? null : value;
};
