import { INestApplication } from '@nestjs/common';
import { io, Socket } from 'socket.io-client';
import request from 'supertest';
import { RealtimeEnvelope } from 'src/realtime/events';
import { agentsRoom, internalRoom, ticketRoom } from 'src/realtime/rooms';
import { RealtimeGateway, SubscribeAck } from 'src/realtime/realtime.gateway';
import { asOwner, contactOf } from './helpers/as-owner';
import { bootApp } from './helpers/boot';
import { seededTenantIds } from './helpers/seeded-tenants';

/**
 * The real-time surface, over a real socket against a real database.
 *
 * The claims worth testing here are the ones a unit test cannot make. `canJoin`
 * is exercised without a framework in `can-join.spec.ts` and the sequencing in
 * `event-log.spec.ts`; what those cannot show is that the gate is actually *on*
 * the subscribe path, that the tenant a socket acts in comes from its token
 * rather than from anything it sends, that a Note written through the ordinary
 * endpoint reaches an agent and not the customer sitting on the same Ticket, and
 * that a reconnecting client is given back exactly what it missed.
 *
 * The Note isolation tests are the centre of the file, and they are written to
 * fail loudly rather than quietly: a widget that receives nothing because it is
 * subscribed to nothing would pass a naive assertion, so each of them proves the
 * socket is live by observing a Message arrive on the same connection.
 *
 * Requires `docker compose up -d postgres && npm run db:migrate && npm run
 * db:seed`; see `npm run test:int`.
 */

const PASSWORD = 'nivara-demo-password';

/** Stamped on every Ticket this suite writes, so cleanup can find them all. */
const MARK = 'realtime-int-spec';

/** The second Meridian Contact this suite creates, and later deletes. */
const STRANGER_EMAIL = 'realtime-int-spec-stranger@example.test';

/** Long enough for a local round trip, short enough that a hang is a failure. */
const SETTLE_MS = 300;

describe('realtime', () => {
  let app: INestApplication;
  let url: string;
  let meridian: string;
  let sortwood: string;
  let agentToken: string;
  let sortwoodToken: string;
  let contactToken: string;
  let contactId: string;
  /** A second Meridian Contact, so "somebody else's Ticket" has an owner. */
  let strangerId: string;

  /** Every socket this suite opened, closed in `afterEach` whatever happened. */
  let open: Socket[] = [];

  beforeAll(async () => {
    app = await bootApp();
    url = await app.getUrl();
    ({ meridian, sortwood } = await seededTenantIds());

    agentToken = await staffTokenFor(meridian, 'agent@meridian.test');
    sortwoodToken = await staffTokenFor(sortwood, 'admin@sortwood.test');
    contactToken = await portalTokenFor(meridian, 'jules@example.test');
    contactId = await contactOf(meridian, 'jules@example.test');

    // Written rather than seeded: the seed gives Meridian exactly one verified
    // Contact, and the ownership refusal needs a *second* one in the same
    // tenant — a Sortwood Contact would be refused by the tenant gate first and
    // would prove the weaker claim.
    [{ id: strangerId }] = await asOwner<{ id: string }>(
      // Columns Prisma fills from the client rather than from a database
      // default have to be named here, because this insert goes around the
      // application on purpose — a Contact created *through* the app would have
      // to be one this Contact could reach, which is the thing under test.
      `INSERT INTO contact (id, tenant_id, email, name, verified, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, 'Stranger', true, now(), now())
       RETURNING id::text`,
      [meridian, STRANGER_EMAIL],
    );
  });

  afterEach(() => {
    for (const socket of open) socket.close();
    open = [];
  });

  afterAll(async () => {
    await app?.close();
    // Messages and Notes cascade with the Ticket they hang off; the stranger's
    // Ticket cascades with the stranger.
    await asOwner(`DELETE FROM ticket WHERE subject LIKE '${MARK}%'`);
    await asOwner(`DELETE FROM contact WHERE email = $1`, [STRANGER_EMAIL]);
  });

  const server = () => request(app.getHttpServer());

  const staffTokenFor = async (
    tenantId: string,
    email: string,
  ): Promise<string> => {
    const { body } = await server()
      .post('/auth/sign-in')
      .send({ tenantId, email, password: PASSWORD })
      .expect(200);

    return body.accessToken as string;
  };

  const portalTokenFor = async (
    tenantId: string,
    email: string,
  ): Promise<string> => {
    const { body } = await server()
      .post('/portal/auth/sign-in')
      .send({ tenantId, email, password: PASSWORD })
      .expect(200);

    return body.accessToken as string;
  };

  /** A Ticket requested by the seeded Contact, so the portal principal owns it. */
  const openTicket = async (suffix: string): Promise<string> => {
    const { body } = await server()
      .post('/tickets')
      .set('Authorization', `Bearer ${agentToken}`)
      .send({ subject: `${MARK} ${suffix}`, contactId, source: 'portal' })
      .expect(201);

    return body.id as string;
  };

  /**
   * A connected socket, or a rejection — the handshake's own answer, awaited.
   *
   * Both outcomes are races against the same connection, which is why they are
   * resolved together rather than by connecting and then asserting on a flag: a
   * test that checked `socket.connected` synchronously would be asserting on the
   * moment before the server had answered.
   */
  const connect = (token?: string): Promise<Socket> => {
    const socket = io(`${url}/rt`, {
      auth: token ? { token } : {},
      transports: ['websocket'],
      reconnection: false,
    });

    open.push(socket);

    return new Promise((resolve, reject) => {
      socket.on('connect', () => resolve(socket));
      socket.on('connect_error', reject);
      socket.on('disconnect', () => reject(new Error('disconnected')));
    });
  };

  const subscribe = (
    socket: Socket,
    room: string,
    afterSeq?: number,
  ): Promise<SubscribeAck> =>
    socket.emitWithAck('subscribe', { room, afterSeq });

  /** Everything that lands on a socket, in arrival order, for later assertion. */
  const record = (socket: Socket): RealtimeEnvelope[] => {
    const seen: RealtimeEnvelope[] = [];

    socket.onAny((_event, envelope: RealtimeEnvelope) => {
      if (envelope?.event) seen.push(envelope);
    });

    return seen;
  };

  /**
   * Waits for the server to have had its chance to deliver.
   *
   * A fixed settle rather than waiting for a specific event, because most
   * assertions here are about what did *not* arrive, and there is nothing to
   * wait for in that case. Where a test asserts a positive delivery it also
   * asserts a negative one on the same wait, so the two share a deadline.
   */
  const settle = (): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

  describe('the handshake', () => {
    it('accepts a staff access token', async () => {
      await expect(connect(agentToken)).resolves.toBeDefined();
    });

    it('accepts a Contact’s portal token', async () => {
      await expect(connect(contactToken)).resolves.toBeDefined();
    });

    it('refuses a connection with no token', async () => {
      await expect(connect()).rejects.toBeDefined();
    });

    it('refuses a token this server did not sign', async () => {
      await expect(connect('not-a-token')).rejects.toBeDefined();
    });

    it('refuses a service token — machines do not hold sockets', async () => {
      const { body } = await server()
        .post('/service-tokens')
        .set(
          'Authorization',
          `Bearer ${await staffTokenFor(meridian, 'admin@meridian.test')}`,
        )
        .send({ name: `${MARK} probe`, scopes: ['ticket:read'] })
        .expect(201);

      await expect(connect(body.token as string)).rejects.toBeDefined();

      await asOwner(`DELETE FROM service_token WHERE name LIKE '${MARK}%'`);
    });
  });

  describe('the room gate', () => {
    it('admits staff to their own tenant’s dashboard', async () => {
      const socket = await connect(agentToken);

      await expect(subscribe(socket, agentsRoom(meridian))).resolves.toEqual(
        expect.objectContaining({ ok: true }),
      );
    });

    it('refuses staff another tenant’s dashboard', async () => {
      const socket = await connect(agentToken);

      await expect(subscribe(socket, agentsRoom(sortwood))).resolves.toEqual({
        ok: false,
        error: 'forbidden',
      });
    });

    it('refuses staff another tenant’s ticket room', async () => {
      const ticketId = await openTicket('cross-tenant');
      const socket = await connect(sortwoodToken);

      await expect(
        subscribe(socket, ticketRoom(meridian, ticketId)),
      ).resolves.toEqual({ ok: false, error: 'forbidden' });
    });

    it('refuses a room name that is not one of ours', async () => {
      const socket = await connect(agentToken);

      await expect(subscribe(socket, 'lobby')).resolves.toEqual({
        ok: false,
        error: 'forbidden',
      });
    });

    it('refuses a malformed subscribe', async () => {
      const socket = await connect(agentToken);

      await expect(
        socket.emitWithAck('subscribe', { room: 7 }),
      ).resolves.toEqual({ ok: false, error: 'malformed_request' });
    });

    it('refuses a Contact the agents firehose', async () => {
      const socket = await connect(contactToken);

      await expect(subscribe(socket, agentsRoom(meridian))).resolves.toEqual({
        ok: false,
        error: 'forbidden',
      });
    });

    it('refuses a Contact the internal Note room of their own Ticket', async () => {
      const ticketId = await openTicket('internal-gate');
      const socket = await connect(contactToken);

      await expect(
        subscribe(socket, internalRoom(meridian, ticketId)),
      ).resolves.toEqual({ ok: false, error: 'forbidden' });
    });

    it('admits a Contact to a Ticket they requested', async () => {
      const ticketId = await openTicket('own-ticket');
      const socket = await connect(contactToken);

      await expect(
        subscribe(socket, ticketRoom(meridian, ticketId)),
      ).resolves.toEqual(expect.objectContaining({ ok: true }));
    });

    it('refuses a Contact a Ticket requested by someone else', async () => {
      const { body } = await server()
        .post('/tickets')
        .set('Authorization', `Bearer ${agentToken}`)
        .send({
          subject: `${MARK} someone-elses`,
          contactId: strangerId,
          source: 'portal',
        })
        .expect(201);

      const socket = await connect(contactToken);

      await expect(
        subscribe(socket, ticketRoom(meridian, body.id as string)),
      ).resolves.toEqual({ ok: false, error: 'forbidden' });
    });
  });

  describe('events', () => {
    it('announces a new Ticket on the dashboard', async () => {
      const socket = await connect(agentToken);
      const seen = record(socket);

      await subscribe(socket, agentsRoom(meridian));

      const ticketId = await openTicket('created-event');

      await settle();

      // Found by id, not by being the only one. The dashboard room is
      // tenant-wide and long-lived, so a fresh subscribe replays whatever other
      // tests in this file put there — which is itself the replay working.
      const created = seen.find(
        (e) =>
          e.event === 'ticket.created' &&
          (e.data as { id: string }).id === ticketId,
      );

      expect(created).toBeDefined();
      expect(created?.room).toBe(agentsRoom(meridian));
      expect(created?.data).toEqual(
        expect.objectContaining({ id: ticketId, state: 'open' }),
      );
      expect(typeof created?.seq).toBe('number');
      expect(Date.parse(created!.ts)).not.toBeNaN();
    });

    it('announces a state transition to the dashboard and the thread', async () => {
      const ticketId = await openTicket('updated-event');

      const dashboard = await connect(agentToken);
      const onDashboard = record(dashboard);
      await subscribe(dashboard, agentsRoom(meridian));

      const thread = await connect(contactToken);
      const onThread = record(thread);
      await subscribe(thread, ticketRoom(meridian, ticketId));

      await server()
        .patch(`/tickets/${ticketId}/state`)
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ state: 'pending' })
        .expect(200);

      await settle();

      for (const seen of [onDashboard, onThread]) {
        expect(
          seen.filter((e) => e.event === 'ticket.updated').map((e) => e.data),
        ).toContainEqual(
          expect.objectContaining({ id: ticketId, state: 'pending' }),
        );
      }
    });

    it('announces an assignment on the dashboard only', async () => {
      const ticketId = await openTicket('assigned-event');

      const dashboard = await connect(agentToken);
      const onDashboard = record(dashboard);
      await subscribe(dashboard, agentsRoom(meridian));

      const thread = await connect(contactToken);
      const onThread = record(thread);
      await subscribe(thread, ticketRoom(meridian, ticketId));

      await server()
        .patch(`/tickets/${ticketId}/assignee`)
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ assigneeId: null })
        .expect(200);

      await settle();

      const assignedTo = (seen: RealtimeEnvelope[]) =>
        seen.filter(
          (e) =>
            e.event === 'ticket.assigned' &&
            (e.data as { id: string }).id === ticketId,
        );

      expect(assignedTo(onDashboard)).toHaveLength(1);
      expect(assignedTo(onThread)).toHaveLength(0);
    });

    it('announces a Message on the Ticket’s room', async () => {
      const ticketId = await openTicket('message-event');
      const socket = await connect(contactToken);
      const seen = record(socket);

      await subscribe(socket, ticketRoom(meridian, ticketId));

      await server()
        .post(`/tickets/${ticketId}/messages`)
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ body: 'we are looking into it' })
        .expect(201);

      await settle();

      const message = seen.find((e) => e.event === 'message.created');

      expect(message?.data).toEqual(
        expect.objectContaining({
          ticketId,
          body: 'we are looking into it',
          authorKind: 'user',
        }),
      );
    });
  });

  describe('Note isolation', () => {
    it('delivers a Note to staff in the internal room', async () => {
      const ticketId = await openTicket('note-to-staff');
      const socket = await connect(agentToken);
      const seen = record(socket);

      await subscribe(socket, internalRoom(meridian, ticketId));

      await server()
        .post(`/tickets/${ticketId}/notes`)
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ body: 'suspect a billing mismatch' })
        .expect(201);

      await settle();

      expect(seen.map((e) => e.event)).toContain('note.created');
    });

    it('withholds a Note from a Contact sitting on the same Ticket', async () => {
      const ticketId = await openTicket('note-isolation');

      const customer = await connect(contactToken);
      const seen = record(customer);

      await subscribe(customer, ticketRoom(meridian, ticketId));

      await server()
        .post(`/tickets/${ticketId}/notes`)
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ body: 'do not show this to the customer' })
        .expect(201);

      // The Message is the control. Without it, a socket that received nothing
      // because it was subscribed to nothing would pass this test.
      await server()
        .post(`/tickets/${ticketId}/messages`)
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ body: 'thanks for your patience' })
        .expect(201);

      await settle();

      expect(seen.map((e) => e.event)).toContain('message.created');
      expect(seen.map((e) => e.event)).not.toContain('note.created');
      expect(JSON.stringify(seen)).not.toContain(
        'do not show this to the customer',
      );
    });

    /**
     * The second barrier, on its own.
     *
     * Every other test here exercises the room — a widget cannot join
     * `:internal`, so it never sees a Note. That leaves the audience filter
     * unproven, because nothing in the ordinary path can mis-route a Note in the
     * first place. So this one reaches past `RealtimeService` and hands the
     * gateway a `note.created` envelope addressed to the *customer-visible*
     * room: exactly the mistake a future emit could make, and the one the
     * filter exists to survive.
     *
     * A Message through the same door is the control, so a delivery path that
     * had simply stopped working could not pass this.
     */
    it('withholds a mis-routed Note even from the room it was addressed to', async () => {
      const ticketId = await openTicket('audience-backstop');
      const room = ticketRoom(meridian, ticketId);

      const customer = await connect(contactToken);
      const seen = record(customer);

      await subscribe(customer, room);

      const gateway = app.get(RealtimeGateway, { strict: false });

      await gateway.deliver({
        event: 'note.created',
        room,
        seq: 1_000_001,
        ts: new Date().toISOString(),
        data: {
          id: 'mis-routed',
          ticketId,
          body: 'addressed to the wrong room entirely',
          authorKind: 'user',
          authorId: null,
          createdAt: new Date().toISOString(),
        },
      });

      await gateway.deliver({
        event: 'message.created',
        room,
        seq: 1_000_002,
        ts: new Date().toISOString(),
        data: {
          id: 'control',
          ticketId,
          body: 'the control',
          authorKind: 'user',
          authorId: null,
          createdAt: new Date().toISOString(),
        },
      });

      await settle();

      expect(seen.map((e) => e.event)).toContain('message.created');
      expect(seen.map((e) => e.event)).not.toContain('note.created');
      expect(JSON.stringify(seen)).not.toContain('the wrong room entirely');
    });

    it('delivers a mis-routed Note to staff in that same room', async () => {
      const ticketId = await openTicket('audience-backstop-staff');
      const room = ticketRoom(meridian, ticketId);

      const agent = await connect(agentToken);
      const seen = record(agent);

      await subscribe(agent, room);

      await app.get(RealtimeGateway, { strict: false }).deliver({
        event: 'note.created',
        room,
        seq: 1_000_003,
        ts: new Date().toISOString(),
        data: {
          id: 'mis-routed-staff',
          ticketId,
          body: 'staff may see this wherever it lands',
          authorKind: 'user',
          authorId: null,
          createdAt: new Date().toISOString(),
        },
      });

      await settle();

      // The filter is about the *audience*, not about tidiness: it withholds
      // from customers, it does not suppress the event.
      expect(seen.map((e) => e.event)).toContain('note.created');
    });
  });

  describe('the widget session', () => {
    /**
     * A real anonymous session, minted through the widget's own bootstrap.
     *
     * The spec names this credential explicitly — "authenticating with either a
     * staff token or a widget session" — and it is the one that cannot be
     * approximated by a Contact's portal token: it is signed by a different key,
     * carries different claims, and is backed by a revocable row. A test that
     * only exercised the portal JWT would leave the widget half of the
     * handshake unproven.
     */
    const widgetSession = async (): Promise<string> => {
      const { body } = await server()
        .post('/widget/sessions')
        .set('Origin', 'https://meridian.example')
        .send({ tenantId: meridian })
        .expect(201);

      return body.token as string;
    };

    it('accepts a widget session token at the handshake', async () => {
      await expect(connect(await widgetSession())).resolves.toBeDefined();
    });

    it('refuses a visitor who has opened no Ticket the room of somebody else’s', async () => {
      const ticketId = await openTicket('widget-not-mine');
      const socket = await connect(await widgetSession());

      // No Contact has been resolved for this session yet, so it has requested
      // nothing — and finding that out must not create a Contact for it.
      await expect(
        subscribe(socket, ticketRoom(meridian, ticketId)),
      ).resolves.toEqual({ ok: false, error: 'forbidden' });
    });

    it('refuses a widget visitor the internal Note room', async () => {
      const ticketId = await openTicket('widget-internal');
      const socket = await connect(await widgetSession());

      await expect(
        subscribe(socket, internalRoom(meridian, ticketId)),
      ).resolves.toEqual({ ok: false, error: 'forbidden' });
    });

    it('refuses a widget visitor the agents firehose', async () => {
      const socket = await connect(await widgetSession());

      await expect(subscribe(socket, agentsRoom(meridian))).resolves.toEqual({
        ok: false,
        error: 'forbidden',
      });
    });

    it('admits a widget visitor to the Ticket they opened, and delivers on it', async () => {
      const token = await widgetSession();

      // Opening a Ticket is what resolves this session to a Contact — the seam
      // the whole widget design turns on, and the reason this has to go through
      // the widget's own endpoint rather than being set up as an agent.
      const { body: ticket } = await server()
        .post('/widget/tickets')
        .set('Authorization', `Bearer ${token}`)
        .set('Origin', 'https://meridian.example')
        .send({ subject: `${MARK} widget-owned` })
        .expect(201);

      const socket = await connect(token);
      const seen = record(socket);

      await expect(
        subscribe(socket, ticketRoom(meridian, ticket.id as string)),
      ).resolves.toEqual(expect.objectContaining({ ok: true }));

      // A Note first, so the isolation claim is made against the credential the
      // spec actually names rather than against a portal Contact standing in
      // for it.
      await server()
        .post(`/tickets/${ticket.id}/notes`)
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ body: 'never visible to the widget' })
        .expect(201);

      await server()
        .post(`/tickets/${ticket.id}/messages`)
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ body: 'have you tried turning it off' })
        .expect(201);

      await settle();

      expect(seen.map((e) => e.event)).toContain('message.created');
      expect(seen.map((e) => e.event)).not.toContain('note.created');
      expect(JSON.stringify(seen)).not.toContain('never visible to the widget');
    });
  });

  describe('sequencing and replay', () => {
    it('numbers a room’s events monotonically', async () => {
      const ticketId = await openTicket('sequencing');
      const socket = await connect(agentToken);
      const seen = record(socket);

      await subscribe(socket, ticketRoom(meridian, ticketId));

      for (const body of ['one', 'two', 'three']) {
        await server()
          .post(`/tickets/${ticketId}/messages`)
          .set('Authorization', `Bearer ${agentToken}`)
          .send({ body })
          .expect(201);
      }

      await settle();

      const seqs = seen
        .filter((e) => e.event === 'message.created')
        .map((e) => e.seq);

      expect(seqs).toHaveLength(3);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(new Set(seqs).size).toBe(3);
    });

    it('replays what a reconnecting client missed, and no more', async () => {
      const ticketId = await openTicket('replay');
      const room = ticketRoom(meridian, ticketId);

      const first = await connect(agentToken);
      const beforeDrop = record(first);
      await subscribe(first, room);

      await server()
        .post(`/tickets/${ticketId}/messages`)
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ body: 'seen before the drop' })
        .expect(201);

      await settle();

      const cursor = Math.max(...beforeDrop.map((e) => e.seq));

      first.close();

      // Missed entirely: nobody is holding this room while it is written.
      await server()
        .post(`/tickets/${ticketId}/messages`)
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ body: 'missed while away' })
        .expect(201);

      const second = await connect(agentToken);
      const afterReturn = record(second);
      const ack = await subscribe(second, room, cursor);

      await settle();

      expect(ack).toEqual(
        expect.objectContaining({ ok: true, replayed: 1, gap: false }),
      );
      expect(afterReturn.map((e) => e.data)).toContainEqual(
        expect.objectContaining({ body: 'missed while away' }),
      );
      expect(JSON.stringify(afterReturn)).not.toContain('seen before the drop');
    });

    /**
     * The *room* barrier on the replay path, not the audience filter.
     *
     * Worth being precise about what this proves, because the obvious reading is
     * wrong: the Note goes to the `:internal` room, so it is not in this room's
     * buffer at all and no filter has to run for it to be absent. What this
     * shows is that replay is scoped to the room subscribed to. The audience
     * filter *on replay* is proved where it can be — against a buffer that
     * genuinely holds a Note — in `event-log.spec.ts`.
     */
    it('scopes a Contact’s replay to the room they joined', async () => {
      const ticketId = await openTicket('replay-isolation');
      const room = ticketRoom(meridian, ticketId);

      await server()
        .post(`/tickets/${ticketId}/notes`)
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ body: 'internal, written while nobody watched' })
        .expect(201);

      await server()
        .post(`/tickets/${ticketId}/messages`)
        .set('Authorization', `Bearer ${agentToken}`)
        .send({ body: 'customer-visible, written while nobody watched' })
        .expect(201);

      const customer = await connect(contactToken);
      const seen = record(customer);

      await subscribe(customer, room, 0);

      await settle();

      expect(seen.map((e) => e.event)).toContain('message.created');
      expect(seen.map((e) => e.event)).not.toContain('note.created');
    });

    it('reports a gap for a cursor beyond anything it issued', async () => {
      const ticketId = await openTicket('gap');
      const socket = await connect(agentToken);

      const ack = await subscribe(
        socket,
        ticketRoom(meridian, ticketId),
        9_999,
      );

      expect(ack).toEqual(expect.objectContaining({ ok: true, gap: true }));
    });

    it('reports no gap to a client that has never seen anything', async () => {
      const ticketId = await openTicket('no-gap');
      const socket = await connect(agentToken);

      const ack = await subscribe(socket, ticketRoom(meridian, ticketId), 0);

      expect(ack).toEqual(expect.objectContaining({ ok: true, gap: false }));
    });
  });
});
