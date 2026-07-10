import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHmac, randomUUID } from 'node:crypto';
import request from 'supertest';
import { AppModule } from 'src/app.module';
import { DrainerService } from 'src/scheduler/drainer.service';
import { SlackClient, PermanentSlackError } from 'src/slack/slack-client';
import { TenancyService } from 'src/tenancy/tenancy.service';
import { asOwner, asOwnerArmed } from './helpers/as-owner';
import { seededTenantIds, SeededTenants } from './helpers/seeded-tenants';

/**
 * The Slack channel, end to end, against a real database and a real queue.
 *
 * Exactly one thing is replaced: `SlackClient`, which is the network. Everything
 * else in these tests is the production path — the real signature verifier over a
 * real raw body, the real dedupe table, the real durable queue, the real
 * `ContactReplyService`, the real triggers and the real row-level security. That
 * boundary is deliberate and it is where the module was designed to be cut: what
 * is worth asserting about this adapter is what it does to the database and what
 * it refuses to do, and neither of those is a question about HTTP to Slack.
 */

const SIGNING_SECRET = 'test-only-slack-signing-secret';

/** Stands in for the workspace, per test, so tests cannot collide on a team id. */
const teamIdFor = (): string =>
  `T${randomUUID().replace(/-/gu, '').slice(0, 12)}`;

const BOT_USER = 'U_NIVARA_BOT';

/**
 * The workspace's own bot token, distinct from the one in configuration.
 *
 * The two differ on purpose: a test asserting that replies are posted under the
 * *installation's* credential would pass against a fallback read if both strings
 * were the same, and the whole point of the credential table is that a second
 * tenant does not authenticate as the first.
 */
const WORKSPACE_TOKEN = 'xoxb-this-workspace-only';

interface Posted {
  channelId: string;
  threadTs: string;
  text: string;
  token?: string;
}

/**
 * The network, under the test's control.
 *
 * `posts` is the assertion surface for "did this reach the customer", and
 * `failWith` is how a far end that is down, or permanently broken, is simulated
 * without waiting on one.
 */
class FakeSlackClient {
  readonly posts: Posted[] = [];
  failWith: Error | null = null;

  postMessage(post: Posted): Promise<{ ts: string }> {
    if (this.failWith) return Promise.reject(this.failWith);

    this.posts.push(post);

    return Promise.resolve({ ts: `${1700000000 + this.posts.length}.000100` });
  }
}

describe('the Slack channel', () => {
  let app: INestApplication;
  let tenants: SeededTenants;
  let drainer: DrainerService;
  let tenancy: TenancyService;
  let slack: FakeSlackClient;
  let teamId: string;

  /**
   * Signs and sends a payload exactly as Slack would.
   *
   * Not `async`, so the supertest chain survives — an `async` wrapper returns a
   * plain promise and `.expect(200)` is gone, which turns every status assertion
   * in this file into a silent no-op.
   */
  const send = (
    payload: unknown,
    options: { secret?: string; at?: number; signature?: string } = {},
  ): request.Test => {
    const body = JSON.stringify(payload);
    const timestamp = String(options.at ?? Math.floor(Date.now() / 1000));

    const signature =
      options.signature ??
      `v0=${createHmac('sha256', options.secret ?? SIGNING_SECRET)
        .update(`v0:${timestamp}:${body}`)
        .digest('hex')}`;

    return request(app.getHttpServer())
      .post('/integrations/slack/events')
      .set('content-type', 'application/json')
      .set('x-slack-request-timestamp', timestamp)
      .set('x-slack-signature', signature)
      .send(body);
  };

  const messageEvent = (over: Record<string, unknown> = {}) => ({
    type: 'event_callback',
    team_id: teamId,
    event_id: `Ev${randomUUID().replace(/-/gu, '').slice(0, 16)}`,
    event: {
      type: 'message',
      channel: 'C_SUPPORT',
      user: 'U_ALICE',
      text: 'the printer is on fire',
      ts: '1700000000.000100',
      ...over,
    },
  });

  const ticketsOnThread = (threadTs: string) =>
    asOwner<{
      id: string;
      state: string;
      source: string;
      subject: string;
      slack_channel_id: string | null;
      contact_id: string;
      spawned_from_ticket_id: string | null;
    }>(
      `SELECT id::text, state::text, source::text, subject, slack_channel_id,
              contact_id::text, spawned_from_ticket_id::text
         FROM ticket WHERE slack_thread_ts = $1 ORDER BY created_at`,
      [threadTs],
    );

  const messagesOn = (ticketId: string) =>
    asOwner<{ body: string; author_kind: string; author_id: string | null }>(
      `SELECT body, author_kind::text, author_id::text
         FROM message WHERE ticket_id = $1 ORDER BY created_at`,
      [ticketId],
    );

  const deliveries = (tenantId: string) =>
    asOwner<{
      id: string;
      status: string;
      target: string;
      source: string;
      attempts: number;
      external_id: string | null;
      last_error: string | null;
    }>(
      `SELECT id::text, status::text, target, source, attempts, external_id, last_error
         FROM outbound_delivery WHERE tenant_id = $1 ORDER BY created_at`,
      [tenantId],
    );

  /**
   * Moves a Ticket, as the owner, with a `system` actor armed.
   *
   * Armed rather than bare, because the state-machine trigger writes an audit row
   * and `audit_log` refuses an insert with no actor in context. That refusal is a
   * guarantee doing its job — history cannot be written by nobody — so the test
   * supplies an actor rather than working around it.
   */
  const moveTo = (ticketId: string, state: string) =>
    asOwnerArmed(
      { tenantId: tenants.meridian, actorKind: 'system' },
      `UPDATE ticket SET state = $2::ticket_state WHERE id = $1`,
      [ticketId, state],
    );

  /** Posts a customer-visible Message as an agent would, through the real service. */
  const agentReplies = async (
    tenantId: string,
    ticketId: string,
    body: string,
  ): Promise<void> => {
    const [staff] = await asOwner<{ id: string }>(
      `SELECT id::text FROM "user" WHERE tenant_id = $1 LIMIT 1`,
      [tenantId],
    );

    const { MessageService } = await import('src/conversation/message.service');

    await app
      .get(MessageService)
      .post(
        { kind: 'user', tenantId, userId: staff.id, role: 'agent' },
        ticketId,
        body,
      );
  };

  beforeAll(async () => {
    tenants = await seededTenantIds();

    process.env['SLACK_SIGNING_SECRET'] = SIGNING_SECRET;
    process.env['SLACK_BOT_TOKEN'] = 'xoxb-test-only';

    slack = new FakeSlackClient();

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SlackClient)
      .useValue(slack)
      .compile();

    // `rawBody`, exactly as `main.ts` sets it. Without it every signature check
    // in this file would run against an empty body and refuse, which would make
    // the whole suite pass or fail for a reason unrelated to its subject.
    app = moduleRef.createNestApplication({ rawBody: true });
    await app.listen(0);

    drainer = app.get(DrainerService);
    tenancy = app.get(TenancyService);
  });

  afterAll(async () => {
    await app.close();

    delete process.env['SLACK_SIGNING_SECRET'];
    delete process.env['SLACK_BOT_TOKEN'];
  });

  beforeEach(async () => {
    slack.posts.length = 0;
    slack.failWith = null;
    teamId = teamIdFor();

    await asOwner('DELETE FROM job');
    await asOwner(`DELETE FROM idempotency_record WHERE scope = 'slack:event'`);

    // The installation, planted as the owner: creating one is an admin act that
    // has no API surface yet, and the OAuth flow that will create it is
    // deliberately out of this ticket's scope.
    const [installation] = await asOwner<{ id: string }>(
      `INSERT INTO slack_installation (id, tenant_id, team_id, bot_user_id, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, now())
       RETURNING id::text`,
      [tenants.meridian, teamId, BOT_USER],
    );

    // The workspace's own bot token, on the table that is deliberately invisible
    // to the pre-tenant lookup context.
    await asOwner(
      `INSERT INTO slack_credential (id, tenant_id, installation_id, bot_access_token, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, now())`,
      [tenants.meridian, installation.id, WORKSPACE_TOKEN],
    );
  });

  afterEach(async () => {
    // Tickets first: the deliveries and messages cascade from them.
    await asOwner(`DELETE FROM ticket WHERE slack_thread_ts IS NOT NULL`);
    await asOwner(`DELETE FROM contact WHERE slack_user_id IS NOT NULL`);
    await asOwner('DELETE FROM slack_credential');
    await asOwner('DELETE FROM slack_installation');
  });

  describe('verification', () => {
    it('accepts a correctly signed request', async () => {
      await send(messageEvent()).expect(200);
    });

    it('refuses a request signed with the wrong secret, before any write', async () => {
      await send(messageEvent(), { secret: 'not-the-secret' }).expect(401);

      // The gate's whole point: nothing was written, nothing was queued, and no
      // dedupe record was claimed. An unverified request leaves no trace.
      expect(await asOwner('SELECT 1 FROM job')).toEqual([]);
      expect(
        await asOwner(
          `SELECT 1 FROM idempotency_record WHERE scope = 'slack:event'`,
        ),
      ).toEqual([]);
      expect(await ticketsOnThread('1700000000.000100')).toEqual([]);
    });

    it('refuses a request older than the replay window', async () => {
      // A genuine, correctly signed request — captured and replayed later. Only
      // the clock can refuse it.
      const stale = Math.floor(Date.now() / 1000) - 301;

      await send(messageEvent(), { at: stale }).expect(401);
      expect(await asOwner('SELECT 1 FROM job')).toEqual([]);
    });

    it('refuses a request carrying no signature at all', async () => {
      await send(messageEvent(), { signature: '' }).expect(401);
    });

    it('refuses a body altered after it was signed', async () => {
      // Signed over one payload, sent as another. This is what verifying the raw
      // bytes buys, and it fails only if the bytes really are what is checked.
      const body = JSON.stringify(messageEvent());
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = `v0=${createHmac('sha256', SIGNING_SECRET)
        .update(`v0:${timestamp}:${body}`)
        .digest('hex')}`;

      await request(app.getHttpServer())
        .post('/integrations/slack/events')
        .set('content-type', 'application/json')
        .set('x-slack-request-timestamp', timestamp)
        .set('x-slack-signature', signature)
        .send(JSON.stringify({ ...messageEvent(), tampered: true }))
        .expect(401);
    });

    it('echoes the URL verification challenge', async () => {
      const response = await send({
        type: 'url_verification',
        challenge: 'abc123',
      }).expect(200);

      expect(response.text).toBe('abc123');
    });
  });

  describe('tenant resolution', () => {
    it('attributes an event to the tenant the verified workspace maps to', async () => {
      await send(messageEvent()).expect(200);

      const jobs = await asOwner<{ tenant_id: string; kind: string }>(
        `SELECT tenant_id::text, kind FROM job`,
      );

      expect(jobs).toEqual([
        { tenant_id: tenants.meridian, kind: 'inbound.event' },
      ]);
    });

    it('never takes the tenant from the payload', async () => {
      // The most important negative in this file. A signed payload naming
      // another tenant is still resolved through the installation record, so the
      // workspace decides and the payload does not get a vote.
      await send({
        ...messageEvent(),
        tenant_id: tenants.sortwood,
        tenantId: tenants.sortwood,
      }).expect(200);

      const jobs = await asOwner<{ tenant_id: string }>(
        `SELECT tenant_id::text FROM job`,
      );

      expect(jobs).toEqual([{ tenant_id: tenants.meridian }]);
    });

    it('acknowledges and drops an event from an uninstalled workspace', async () => {
      // Genuinely from Slack — the signature says so — about a workspace we have
      // no arrangement with. Refusing would have Slack retrying forever an event
      // that can never be processed.
      await send({ ...messageEvent(), team_id: teamIdFor() }).expect(200);

      expect(await asOwner('SELECT 1 FROM job')).toEqual([]);
    });
  });

  describe('deduplication', () => {
    it('queues one job for an event delivered twice', async () => {
      const event = messageEvent();

      await send(event).expect(200);
      await send(event).expect(200);

      expect(await asOwner('SELECT 1 FROM job')).toHaveLength(1);
    });

    it('opens no second Ticket when Slack redelivers', async () => {
      const event = messageEvent();

      await send(event).expect(200);
      await drainer.tick();
      await send(event).expect(200);
      await drainer.tick();

      expect(await ticketsOnThread('1700000000.000100')).toHaveLength(1);
    });
  });

  describe('ingestion', () => {
    it('opens a Ticket with source slack from a top-level message', async () => {
      await send(messageEvent()).expect(200);
      await drainer.tick();

      const [ticket] = await ticketsOnThread('1700000000.000100');

      expect(ticket).toMatchObject({
        source: 'slack',
        state: 'open',
        subject: 'the printer is on fire',
        slack_channel_id: 'C_SUPPORT',
      });
    });

    it('posts the customer’s words as the first Message, attributed to them', async () => {
      await send(messageEvent()).expect(200);
      await drainer.tick();

      const [ticket] = await ticketsOnThread('1700000000.000100');
      const messages = await messagesOn(ticket.id);

      // `contact`, not `system` — the drainer arms `system` and the handler
      // deliberately does not use that transaction for domain writes. Getting
      // this wrong would make the first-response clock and the deflection metric
      // both lie about a conversation that arrived through a robot.
      expect(messages).toEqual([
        {
          body: 'the printer is on fire',
          author_kind: 'contact',
          author_id: ticket.contact_id,
        },
      ]);
    });

    it('upserts one Contact per tenant and Slack user', async () => {
      await send(messageEvent()).expect(200);
      await drainer.tick();

      await send(
        messageEvent({ ts: '1700000500.000100', text: 'also the kettle' }),
      ).expect(200);
      await drainer.tick();

      const contacts = await asOwner<{ id: string; verified: boolean }>(
        `SELECT id::text, verified FROM contact
          WHERE tenant_id = $1 AND slack_user_id = 'U_ALICE'`,
        [tenants.meridian],
      );

      expect(contacts).toHaveLength(1);
      // Slack asserted this identity and we did not.
      expect(contacts[0].verified).toBe(false);
    });

    it('appends a thread reply to the Ticket the thread already has', async () => {
      await send(messageEvent()).expect(200);
      await drainer.tick();

      await send(
        messageEvent({
          ts: '1700000009.000200',
          thread_ts: '1700000000.000100',
          text: 'and now the desk',
        }),
      ).expect(200);
      await drainer.tick();

      const tickets = await ticketsOnThread('1700000000.000100');

      expect(tickets).toHaveLength(1);
      expect((await messagesOn(tickets[0].id)).map((m) => m.body)).toEqual([
        'the printer is on fire',
        'and now the desk',
      ]);
    });

    it('reopens a resolved Ticket on a thread reply', async () => {
      await send(messageEvent()).expect(200);
      await drainer.tick();

      const [ticket] = await ticketsOnThread('1700000000.000100');

      await moveTo(ticket.id, 'resolved');

      await send(
        messageEvent({
          ts: '1700000009.000200',
          thread_ts: '1700000000.000100',
          text: 'it is still broken',
        }),
      ).expect(200);
      await drainer.tick();

      // Straight through `ContactReplyService`, so a Slack customer gets exactly
      // the reopen a portal customer gets — same code, not a second copy of the
      // rule.
      const [reopened] = await ticketsOnThread('1700000000.000100');

      expect(reopened.state).toBe('open');
    });

    it('spawns a linked Ticket that inherits the thread when the chain is closed', async () => {
      await send(messageEvent()).expect(200);
      await drainer.tick();

      const [origin] = await ticketsOnThread('1700000000.000100');

      await moveTo(origin.id, 'resolved');
      await moveTo(origin.id, 'closed');

      await send(
        messageEvent({
          ts: '1700000900.000200',
          thread_ts: '1700000000.000100',
          text: 'this happened again',
        }),
      ).expect(200);
      await drainer.tick();

      const chain = await ticketsOnThread('1700000000.000100');

      expect(chain).toHaveLength(2);
      // The route is inherited by the trigger, not by a call site — which is
      // what makes it impossible to spawn a Ticket the customer cannot be
      // reached on.
      expect(chain[1]).toMatchObject({
        state: 'open',
        slack_channel_id: 'C_SUPPORT',
        spawned_from_ticket_id: origin.id,
      });
    });

    it('ignores the adapter’s own postings', async () => {
      await send(messageEvent({ user: BOT_USER, text: 'we are on it' })).expect(
        200,
      );
      await drainer.tick();

      // Without this the reply-back path is an echo loop: every agent reply is
      // delivered, ingested straight back, and appended as though the customer
      // said it.
      expect(await ticketsOnThread('1700000000.000100')).toEqual([]);
    });

    it('ignores an edited message', async () => {
      await send(messageEvent({ subtype: 'message_changed' })).expect(200);
      await drainer.tick();

      expect(await ticketsOnThread('1700000000.000100')).toEqual([]);
    });
  });

  describe('reply-back delivery', () => {
    const openTicket = async (): Promise<string> => {
      await send(messageEvent()).expect(200);
      await drainer.tick();

      const [ticket] = await ticketsOnThread('1700000000.000100');

      return ticket.id;
    };

    it('delivers an agent’s Message into the Slack thread', async () => {
      const ticketId = await openTicket();

      await agentReplies(tenants.meridian, ticketId, 'engineer on the way');
      await drainer.tick();

      expect(slack.posts).toHaveLength(1);
      // `toMatchObject`, because the credential this was posted under is the
      // subject of its own test below and does not belong in this assertion.
      expect(slack.posts[0]).toMatchObject({
        channelId: 'C_SUPPORT',
        threadTs: '1700000000.000100',
        text: 'engineer on the way',
      });
    });

    it('posts under the workspace’s own credential, not the process-wide one', async () => {
      // The reason `slack_credential` exists. A single configured token
      // authenticates against exactly one workspace, so a second tenant's replies
      // would fail `invalid_auth` — which is classified permanent, so they would
      // die on their first attempt rather than degrade.
      const ticketId = await openTicket();

      await agentReplies(tenants.meridian, ticketId, 'engineer on the way');
      await drainer.tick();

      expect(slack.posts[0].token).toBe(WORKSPACE_TOKEN);
    });

    it('records the delivery once, with what Slack called it', async () => {
      const ticketId = await openTicket();

      await agentReplies(tenants.meridian, ticketId, 'engineer on the way');
      await drainer.tick();

      const [delivery] = await deliveries(tenants.meridian);

      expect(delivery).toMatchObject({
        status: 'delivered',
        source: 'slack',
        target: 'C_SUPPORT/1700000000.000100',
        attempts: 1,
      });
      expect(delivery.external_id).not.toBeNull();
    });

    it('never double-posts when the delivery job runs again', async () => {
      // The at-least-once window made concrete: a process killed between posting
      // and settling leaves a lease that expires and is handed out again. The
      // `delivered` claim is what stops the second run reaching the customer.
      const ticketId = await openTicket();

      await agentReplies(tenants.meridian, ticketId, 'engineer on the way');
      await drainer.tick();

      await asOwner(
        `UPDATE job SET status = 'ready', locked_at = NULL
          WHERE kind = 'outbound.delivery'`,
      );
      await drainer.tick();

      expect(slack.posts).toHaveLength(1);
    });

    it('never delivers a Note', async () => {
      const ticketId = await openTicket();

      const { NoteService } = await import('src/conversation/note.service');
      const [staff] = await asOwner<{ id: string }>(
        `SELECT id::text FROM "user" WHERE tenant_id = $1 LIMIT 1`,
        [tenants.meridian],
      );

      await app.get(NoteService).write(
        {
          kind: 'user',
          tenantId: tenants.meridian,
          userId: staff.id,
          role: 'agent',
        },
        ticketId,
        'the customer has done this three times',
      );
      await drainer.tick();

      // Internal reasoning stays internal, and it stays internal structurally:
      // nothing connects `NoteService` to the outbound pipe.
      expect(slack.posts).toEqual([]);
      expect(await deliveries(tenants.meridian)).toEqual([]);
    });

    it('never posts the customer’s own words back at them', async () => {
      const ticketId = await openTicket();

      await send(
        messageEvent({
          ts: '1700000009.000200',
          thread_ts: '1700000000.000100',
          text: 'and now the desk',
        }),
      ).expect(200);
      await drainer.tick();
      await drainer.tick();

      expect(slack.posts).toEqual([]);
      expect(await deliveries(tenants.meridian)).toEqual([]);
      expect(ticketId).toBeDefined();
    });

    it('never delivers a state change', async () => {
      const ticketId = await openTicket();

      await moveTo(ticketId, 'pending');
      await drainer.tick();

      expect(slack.posts).toEqual([]);
    });

    it('retries a transient failure and self-heals', async () => {
      const ticketId = await openTicket();

      slack.failWith = new Error('slack is having a moment');

      await agentReplies(tenants.meridian, ticketId, 'engineer on the way');
      await drainer.tick();

      const [failing] = await deliveries(tenants.meridian);

      expect(failing).toMatchObject({ status: 'pending', attempts: 1 });
      expect(failing.last_error).toContain('having a moment');

      // The far end comes back. The clock is moved forward rather than waited
      // on — backoff is a column, so a test can simply be later.
      slack.failWith = null;
      await drainer.tick(new Date(Date.now() + 3_600_000));

      expect(slack.posts).toHaveLength(1);
      expect((await deliveries(tenants.meridian))[0]).toMatchObject({
        status: 'delivered',
      });
    });
  });

  describe('permanent delivery failure', () => {
    it('notifies without mutating the Ticket', async () => {
      await send(messageEvent()).expect(200);
      await drainer.tick();

      const [ticket] = await ticketsOnThread('1700000000.000100');

      slack.failWith = new PermanentSlackError(
        'Slack refused the post: channel_not_found',
      );

      await agentReplies(tenants.meridian, ticket.id, 'engineer on the way');
      await drainer.tick();

      const [delivery] = await deliveries(tenants.meridian);

      expect(delivery.status).toBe('dead');
      expect(delivery.last_error).toContain('channel_not_found');

      // A system audit row, so the failure is in the record rather than only in
      // a log somebody has to go and find.
      const audit = await asOwner<{
        action: string;
        actor_kind: string;
        target_kind: string;
        ticket_id: string | null;
      }>(
        `SELECT action::text, actor_kind::text, target_kind, ticket_id::text
           FROM audit_log WHERE ticket_id = $1 AND action = 'integration.failed'`,
        [ticket.id],
      );

      expect(audit).toEqual([
        {
          action: 'integration.failed',
          actor_kind: 'system',
          target_kind: 'integration',
          ticket_id: ticket.id,
        },
      ]);

      // Notify, don't mutate. An integration giving up must not be able to
      // rewrite a tenant's queue.
      const [after] = await ticketsOnThread('1700000000.000100');

      expect(after.state).toBe(ticket.state);
    });

    it('stops trying rather than exhausting attempts on a permanent error', async () => {
      await send(messageEvent()).expect(200);
      await drainer.tick();

      const [ticket] = await ticketsOnThread('1700000000.000100');

      slack.failWith = new PermanentSlackError(
        'Slack refused the post: is_archived',
      );

      await agentReplies(tenants.meridian, ticket.id, 'engineer on the way');
      await drainer.tick();

      // One attempt, not five. A channel that was archived will still be
      // archived in five minutes, and spending four more attempts to learn that
      // is four more minutes of an agent believing their reply landed.
      expect((await deliveries(tenants.meridian))[0]).toMatchObject({
        status: 'dead',
        attempts: 1,
      });
    });
  });

  describe('isolation', () => {
    it('shows a tenant only its own installations', async () => {
      const visible = await tenancy.withTenant(
        { tenantId: tenants.sortwood, actor: { kind: 'system' } },
        (tx) => tx.slackInstallation.findMany(),
      );

      expect(visible).toEqual([]);
    });

    it('hides installations from a Contact, as `job` and `note` do', async () => {
      const visible = await tenancy.withTenant(
        {
          tenantId: tenants.meridian,
          actor: { kind: 'contact', id: tenants.meridian },
        },
        (tx) => tx.slackInstallation.findMany(),
      );

      expect(visible).toEqual([]);
    });

    it('shows the lookup context nothing but the installations', async () => {
      // The blast radius of the third narrow context, asserted rather than
      // reviewed.
      //
      // A Ticket is ingested first so that every table below genuinely has rows
      // in it. A zero from an empty table would pass whether the policies work or
      // not, which is the way an isolation test quietly stops testing anything —
      // and the seeded Tickets cannot be relied on, since sibling suites delete
      // theirs.
      await send(messageEvent()).expect(200);
      await drainer.tick();

      const populated = await asOwner<{ count: string }>(
        `SELECT count(*)::text FROM contact
         UNION ALL SELECT count(*)::text FROM ticket
         UNION ALL SELECT count(*)::text FROM audit_log`,
      );

      expect(populated.every((row) => Number(row.count) > 0)).toBe(true);

      const seen = await tenancy.withInstallationLookup(async (tx) => ({
        installations: await tx.slackInstallation.count(),
        contacts: await tx.contact.count(),
        tickets: await tx.ticket.count(),
        auditLog: await tx.auditLog.count(),
      }));

      expect(seen).toEqual({
        installations: 1,
        contacts: 0,
        tickets: 0,
        auditLog: 0,
      });
    });

    it('names the installation setting in the policies of exactly one table', async () => {
      // A later migration reaching for the same clause to make its own life
      // easier fails here, which is the only place that would notice.
      const policies = await asOwner<{
        tablename: string;
        policyname: string;
      }>(
        `SELECT tablename, policyname
           FROM pg_policies
          WHERE qual LIKE '%app.installations%'
             OR with_check LIKE '%app.installations%'`,
      );

      expect(policies).toEqual([
        { tablename: 'slack_installation', policyname: 'installation_lookup' },
      ]);
    });

    it('hides bot tokens from the lookup context entirely', async () => {
      // The credential table carries no lookup policy, which is the entire reason
      // it is a separate table: row-level security narrows rows and cannot narrow
      // columns, so a token on the installation row would be readable by whatever
      // holds the pre-tenant context.
      const seen = await tenancy.withInstallationLookup((tx) =>
        tx.slackCredential.count(),
      );

      expect(seen).toBe(0);
    });

    it('shows a tenant only its own bot tokens', async () => {
      const visible = await tenancy.withTenant(
        { tenantId: tenants.sortwood, actor: { kind: 'system' } },
        (tx) => tx.slackCredential.findMany(),
      );

      expect(visible).toEqual([]);
    });

    it('keeps deliveries out of a Contact’s view', async () => {
      const visible = await tenancy.withTenant(
        {
          tenantId: tenants.meridian,
          actor: { kind: 'contact', id: tenants.meridian },
        },
        (tx) => tx.outboundDelivery.findMany(),
      );

      expect(visible).toEqual([]);
    });
  });
});
