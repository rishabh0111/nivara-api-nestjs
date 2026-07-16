import { randomUUID } from 'node:crypto';
import { SUPPORT_WORK } from '../../src/authz/permissions';
import {
  CONTACT_IDS,
  SERVICE_TOKEN_ID,
  SHARED_EMAIL,
  SHARED_GOOGLE_SUBJECT,
  SLACK_TEAM_ID,
  TENANT_IDS,
  TICKET_IDS,
  USER_IDS,
} from './anchors';
import { ContactPlan, TenantPlan, TicketPlan } from './plan';

/**
 * Meridian: the tenant the demo is actually for.
 *
 * Everything here answers one question — what does a developer see thirty
 * seconds after `docker compose up`, with no keys configured? An empty queue
 * answers it badly, and so does a queue of fifty identical Tickets: the features
 * worth showing are the ones that only appear in particular shapes of data. A
 * breached SLA needs a Ticket nobody answered. A paused clock needs one waiting
 * on the customer. A non-zero deflection rate needs Tickets the AI closed with
 * no human on the thread. None of those can be demonstrated by volume.
 *
 * So the backlog is composed rather than generated: a handful of hand-written
 * reference Tickets that documentation quotes by id, and a body of routine work
 * built from a fixed table of shapes. Nothing here is random. A seed with a
 * random number generator in it produces a different demo every run and a
 * different failure every time somebody reports one.
 */

/** Where the AI's replies come from, and what the thread looks like when it works. */
const AI_SIGNATURE = 'Meridian Assistant';

const USERS = [
  {
    id: USER_IDS.meridianAdmin,
    email: 'admin@meridian.test',
    name: 'Ada Okonjo',
    role: 'admin' as const,
  },
  {
    id: USER_IDS.meridianAgent,
    email: 'agent@meridian.test',
    name: 'Ravi Menon',
    role: 'agent' as const,
  },
  {
    id: USER_IDS.meridianAgentTwo,
    email: 'mei@meridian.test',
    name: 'Mei Lin',
    role: 'agent' as const,
  },
  {
    id: USER_IDS.meridianAgentThree,
    email: 'tomas@meridian.test',
    name: 'Tomás Ibarra',
    role: 'agent' as const,
  },
  {
    // Deliberately the same address as a Sortwood User. Tenant-local identity
    // (ADR-0001) is only demonstrable if some address actually exists in two
    // tenants: these are two Users, two rows, two passwords, and neither login
    // can reach the other. `agent` here and `admin` there, so a sign-in that
    // resolved the wrong row would be visible in the role it handed back.
    id: USER_IDS.meridianAgentFour,
    email: SHARED_EMAIL,
    name: 'Iris Vance',
    role: 'agent' as const,
    googleSubject: SHARED_GOOGLE_SUBJECT,
  },
];

/** The four who carry the queue. The admin picks up work too, but is not routed it. */
const AGENTS = [
  USER_IDS.meridianAgent,
  USER_IDS.meridianAgentTwo,
  USER_IDS.meridianAgentThree,
  USER_IDS.meridianAgentFour,
];

const NAMED_CONTACTS: readonly (readonly [string, string])[] = [
  ['jules@example.test', 'Jules Ferrand'],
  ['priya@example.test', 'Priya Raghunathan'],
  ['dmitri@example.test', 'Dmitri Sokolov'],
  ['hana@example.test', 'Hana Takeda'],
  ['olu@example.test', 'Olu Adeyemi'],
  ['marta@example.test', 'Marta Kowalczyk'],
  ['ben@example.test', 'Ben Thackeray'],
  ['sofia@example.test', 'Sofia Marchetti'],
  ['kwame@example.test', 'Kwame Boateng'],
  ['lena@example.test', 'Lena Hofmann'],
  ['arjun@example.test', 'Arjun Kapoor'],
  ['nadia@example.test', 'Nadia Haddad'],
  ['felix@example.test', 'Felix Brenner'],
  ['yuki@example.test', 'Yuki Morimoto'],
  ['claire@example.test', 'Claire Dubois'],
  ['rafael@example.test', 'Rafael Costa'],
  ['ingrid@example.test', 'Ingrid Solberg'],
  ['tariq@example.test', 'Tariq Al-Mansour'],
  ['esme@example.test', 'Esme Wren'],
];

/**
 * Nineteen identified Contacts and one who never said who they are.
 *
 * The anonymous one is not padding. It is the widget-born case — no email, no
 * password, no way to sign in to the portal — and a seed without one would make
 * `Contact.email` look required to anyone reading the data rather than the
 * schema.
 */
const CONTACTS: ContactPlan[] = [
  ...NAMED_CONTACTS.map(([email, name], index) => ({
    id: index === 0 ? CONTACT_IDS.meridianJules : randomUUID(),
    email,
    name,
    // Two who arrived through the widget and never confirmed the address they
    // typed, so the verified flag has both values in the data.
    verified: index !== 5 && index !== 12,
  })),
  { id: randomUUID(), email: null, name: null, verified: false },
];

/** A rotation, so the demo's Contacts, agents and topics are not all one row. */
const cycle = <T>(items: readonly T[], index: number): T =>
  items[index % items.length];

/** One support conversation, reused across Tickets with different outcomes. */
interface Topic {
  subject: string;
  asked: string;
  answered: string;
  /** What the AI layer says when it handles this alone. */
  deflected: string;
  note: string;
}

const TOPICS: readonly Topic[] = [
  {
    subject: 'Invoice shows the wrong billing address',
    asked:
      'Our last invoice still lists the old office. Can you correct it and resend?',
    answered:
      'Updated the billing address on your account and reissued the invoice — it should be in your inbox now.',
    deflected:
      'You can change the billing address under Settings → Billing, then use “Reissue” on the invoice to get a corrected copy. — ' +
      AI_SIGNATURE,
    note: 'Address changed on the account record; no refund involved, so no finance sign-off needed.',
  },
  {
    subject: 'SSO login loops back to the sign-in page',
    asked:
      'Signing in with our identity provider bounces straight back to the login screen.',
    answered:
      'That was a stale assertion consumer URL on your connection. I have corrected it — please try again.',
    deflected:
      'A redirect loop after SSO is almost always a mismatched reply URL. Compare the ACS URL in your provider against the one shown on the Connections page. — ' +
      AI_SIGNATURE,
    note: 'Provider metadata was rotated last week; worth checking whether other tenants on the same IdP are affected.',
  },
  {
    subject: 'Export stops at ten thousand rows',
    asked: 'The CSV export cuts off partway through. We need the full year.',
    answered:
      'Exports above ten thousand rows are queued and emailed instead of downloaded. I have started one for the full year.',
    deflected:
      'Large exports are delivered by email rather than in the browser. Choose “Email export” on the same dialog and it will cover the whole range. — ' +
      AI_SIGNATURE,
    note: 'Third report of this phrasing being unclear. Filed against the docs, not the export itself.',
  },
  {
    subject: 'Webhook deliveries stopped overnight',
    asked:
      'We stopped receiving webhooks around 02:00 and nothing has arrived since.',
    answered:
      'Your endpoint was returning 500s and the retries exhausted, which disabled it. I have re-enabled delivery now that it is healthy.',
    deflected:
      'A disabled endpoint is usually the result of exhausted retries. Re-enable it on the Webhooks page once your service is answering 2xx again. — ' +
      AI_SIGNATURE,
    note: 'Endpoint was down for roughly forty minutes. No data lost — the queue replayed cleanly.',
  },
  {
    subject: 'Cannot add a fifth seat',
    asked:
      'Adding another teammate says we have run out of seats, but we only have four.',
    answered:
      'A deactivated account was still holding a seat. I have released it, so the invite will go through now.',
    deflected:
      'Deactivated members keep their seat until they are removed. Remove them from Settings → Team and the seat frees immediately. — ' +
      AI_SIGNATURE,
    note: 'Seat accounting is confusing here. Worth raising with product rather than answering one ticket at a time.',
  },
  {
    subject: 'Timestamps are shown in the wrong timezone',
    asked:
      'Every timestamp in the dashboard is three hours behind for our team.',
    answered:
      'The workspace timezone was still set to UTC. Changed it to your local zone — the dashboard will follow.',
    deflected:
      'Dashboard times follow the workspace timezone rather than your browser. It is under Settings → General. — ' +
      AI_SIGNATURE,
    note: 'Customer expected browser-local. Reasonable expectation; noted for the settings copy.',
  },
  {
    subject: 'Bulk import rejects half the file',
    asked:
      'Our import fails on about half the rows with no explanation of which ones.',
    answered:
      'The failing rows had blank country codes. I have attached the rejected rows with the reason on each.',
    deflected:
      'The import summary has a “Download rejected rows” link with a reason column — that is the fastest way to see what failed. — ' +
      AI_SIGNATURE,
    note: 'The error summary really is unhelpful without the download. Logged.',
  },
  {
    subject: 'API returns 429 well below the documented limit',
    asked: 'We are seeing rate limits at roughly half the published ceiling.',
    answered:
      'The ceiling is per credential rather than per account, and you have two integrations sharing one key. Minting a second key will separate them.',
    deflected:
      'Rate limits apply per credential, not per account. If several integrations share a key they share its ceiling — mint one key each. — ' +
      AI_SIGNATURE,
    note: 'Confirmed against the limiter logs: two callers, one token.',
  },
  {
    subject: 'Deleted a project by mistake',
    asked: 'One of our projects was deleted this morning and we need it back.',
    answered:
      'Restored from this morning’s snapshot. Everything up to 08:40 is back; anything after that was not captured.',
    deflected:
      'Deleted projects stay recoverable for thirty days. Ask here with the project name and we can restore it. — ' +
      AI_SIGNATURE,
    note: 'Restored from snapshot. Customer informed about the forty-minute gap.',
  },
  {
    subject: 'Two-factor codes are rejected',
    asked: 'Our admin’s authenticator codes stopped working this week.',
    answered:
      'The device clock had drifted by about ninety seconds. Resyncing it in the authenticator app fixed the codes.',
    deflected:
      'Rejected codes are nearly always clock drift on the phone. Use your authenticator’s “sync time” option and try again. — ' +
      AI_SIGNATURE,
    note: 'No account compromise indicators. Left the account as is.',
  },
  {
    subject: 'Search misses recently created records',
    asked:
      'Records created in the last few minutes do not come back in search.',
    answered:
      'Search indexes asynchronously and was running about four minutes behind. It has caught up.',
    deflected:
      'Search is eventually consistent and usually lags by under a minute. If it is longer than that, tell us and we will look. — ' +
      AI_SIGNATURE,
    note: 'Index lag peaked at four minutes during the backfill. Expected, but the customer had no way to know that.',
  },
  {
    subject: 'Need a copy of last quarter’s usage data',
    asked: 'Finance is asking for our usage figures for the last quarter.',
    answered:
      'Attached the quarterly usage breakdown. You can also pull the same figures from the analytics endpoint if you would rather automate it.',
    deflected:
      'Quarterly usage is available under Analytics → Usage, and the same figures are on the analytics API if you would rather automate it. — ' +
      AI_SIGNATURE,
    note: 'Recurring quarterly request from this account. Worth showing them the API once.',
  },
];

/**
 * The routine backlog, as a table of shapes rather than fifty literals.
 *
 * Each name describes what the Ticket demonstrates, and the counts are the
 * distribution: a queue that is mostly settled work with live work on top, which
 * is what a real support inbox looks like and what makes the analytics figures
 * mean anything.
 */
const SHAPES = {
  /** Live work somebody owns. */
  'open-assigned': 7,
  /** Live work nobody has picked up — there is no `new` state, only a null assignee. */
  'open-untriaged': 3,
  /** Waiting on the customer, so the resolution clock is stopped. */
  pending: 7,
  /** Blocked internally, and deliberately *not* paused: the customer is still waiting. */
  'on-hold': 4,
  resolved: 9,
  closed: 6,
  /** Answered and resolved by the AI layer, with no human on the thread. */
  'deflected-resolved': 4,
  'deflected-closed': 4,
} as const;

type Shape = keyof typeof SHAPES;

const isDeflected = (shape: Shape): boolean => shape.startsWith('deflected');
const isLive = (shape: Shape): boolean =>
  shape === 'open-assigned' ||
  shape === 'open-untriaged' ||
  shape === 'pending' ||
  shape === 'on-hold';

/** Every routine Ticket, in one flat list, in the order the counts above give. */
const ROUTINE: readonly Shape[] = (Object.keys(SHAPES) as Shape[]).flatMap(
  (shape) => Array<Shape>(SHAPES[shape]).fill(shape),
);

const PRIORITIES = [
  'normal',
  'high',
  'normal',
  'low',
  'urgent',
  'normal',
  'high',
  'normal',
] as const;
const SOURCES = [
  'portal',
  'portal',
  'widget',
  'portal',
  'widget',
  'slack',
  'widget',
  'portal',
] as const;

/**
 * How old each Ticket is, by whether it is finished.
 *
 * Live work is recent and settled work is old, which is the property that keeps
 * the SLA picture honest rather than uniformly alarming: a resolution target of
 * three days means every open Ticket older than three days is breached, so
 * scattering live work across six weeks would produce a demo queue in which
 * everything is on fire and the breach count says nothing.
 */
const LIVE_NEWEST = 0.3;
const LIVE_SPACING = 0.2;
const SETTLED_OLDEST_INDEX = 8;
const SETTLED_SPACING = 1.55;

/**
 * Every fifth settled Ticket took far longer than its target.
 *
 * Without these the only breaches in the demo would be on unanswered live
 * Tickets, and the resolution-breach rate — a headline figure — would be zero
 * with nothing to explain why.
 */
const isSlow = (index: number): boolean => index % 5 === 4;

const routineTicket = (
  shape: Shape,
  index: number,
  rank: Ranks,
): TicketPlan => {
  const topic = cycle(TOPICS, index);
  const contact = cycle(CONTACTS, index);
  const priority = cycle(PRIORITIES, index);
  const source = cycle(SOURCES, index);

  const openedDaysAgo = isLive(shape)
    ? LIVE_NEWEST + rank.live * LIVE_SPACING
    : SETTLED_OLDEST_INDEX + rank.settled * SETTLED_SPACING;

  // Offsets *after* opening, converted to days-ago at the point of use. Writing
  // them this way round is what stops an off-by-one from producing a reply that
  // predates the question — an ordering the database has no opinion about and
  // that would quietly break the first-response clock.
  const after = (days: number): number => openedDaysAgo - days;

  const base = {
    id: randomUUID(),
    subject: topic.subject,
    contactId: contact.id,
    source,
    priority,
    openedDaysAgo,
    slackRoute:
      source === 'slack'
        ? {
            channelId: 'C5EED0SUPPORT',
            threadTs: `${1_700_000_000 + index}.000100`,
          }
        : undefined,
  };

  const asked = {
    daysAgo: openedDaysAgo,
    by: 'contact' as const,
    body: topic.asked,
  };
  const answered = {
    daysAgo: after(0.02),
    by: 'agent' as const,
    body: topic.answered,
  };
  const internal = {
    daysAgo: after(0.05),
    by: 'agent' as const,
    body: topic.note,
    internal: true,
  };

  if (isDeflected(shape)) {
    const resolvedAt = after(0.01);

    return {
      ...base,
      // Unassigned, necessarily: a Ticket the AI handled alone that an agent was
      // also holding would be two contradictory claims, and the assignee
      // breakdown excludes deflected Tickets for exactly that reason.
      assigneeId: null,
      thread: [
        asked,
        { daysAgo: after(0.005), by: 'ai', body: topic.deflected },
      ],
      path:
        shape === 'deflected-closed'
          ? [
              {
                to: 'resolved' as const,
                daysAgo: resolvedAt,
                by: 'ai' as const,
              },
              { to: 'closed' as const, daysAgo: after(1), by: 'ai' as const },
            ]
          : [
              {
                to: 'resolved' as const,
                daysAgo: resolvedAt,
                by: 'ai' as const,
              },
            ],
    };
  }

  const assigneeId = shape === 'open-untriaged' ? null : cycle(AGENTS, index);

  if (shape === 'open-assigned') {
    return { ...base, assigneeId, thread: [asked, answered], path: [] };
  }

  if (shape === 'open-untriaged') {
    // No reply at all, which is what makes these the Tickets the first-response
    // sweep latches. Nobody has answered and nobody owns it — the two facts a
    // triage queue exists to surface.
    return { ...base, assigneeId, thread: [asked], path: [] };
  }

  if (shape === 'pending') {
    return {
      ...base,
      assigneeId,
      thread: [asked, answered],
      path: [{ to: 'pending', daysAgo: after(0.02) }],
    };
  }

  if (shape === 'on-hold') {
    return {
      ...base,
      assigneeId,
      thread: [asked, answered, internal],
      path: [{ to: 'on_hold', daysAgo: after(0.06) }],
    };
  }

  const resolvedAfter = isSlow(index) ? 4.5 : 0.8;

  const settled = {
    ...base,
    assigneeId,
    thread: [
      asked,
      answered,
      {
        daysAgo: after(0.5),
        by: 'contact' as const,
        body: 'That worked — thank you.',
      },
      {
        daysAgo: after(0.6),
        by: 'agent' as const,
        body: 'Glad to hear it. I will close this off unless anything else comes up.',
      },
      internal,
    ],
  };

  return shape === 'closed'
    ? {
        ...settled,
        path: [
          { to: 'resolved' as const, daysAgo: after(resolvedAfter) },
          { to: 'closed' as const, daysAgo: after(resolvedAfter + 2) },
        ],
      }
    : {
        ...settled,
        path: [{ to: 'resolved' as const, daysAgo: after(resolvedAfter) }],
      };
};

/** How far down its own age series a Ticket sits — live and settled run separately. */
interface Ranks {
  live: number;
  settled: number;
}

const routineTickets = (): TicketPlan[] => {
  const ranks: Ranks = { live: 0, settled: 0 };

  return ROUTINE.map((shape, index) => {
    const ticket = routineTicket(shape, index, { ...ranks });

    if (isLive(shape)) ranks.live += 1;
    else ranks.settled += 1;

    return ticket;
  });
};

/**
 * The Tickets documentation quotes by id, one per shape worth writing about.
 *
 * Hand-written rather than pulled out of the routine list, because a reference
 * has to stay what it says it is. A generated Ticket that happened to be
 * breached today is one distribution tweak away from not being, and the README
 * would go quietly wrong.
 */
const referenceTickets = (): TicketPlan[] => {
  const jules = CONTACT_IDS.meridianJules;

  return [
    {
      // Six hours old, urgent, and unanswered. The urgent first-response target
      // is one hour, so this is past it and the latch is set — while the
      // eight-hour resolution target is still running, which is what makes it a
      // clean example of one clock rather than both.
      id: TICKET_IDS.breached,
      subject: 'Production API returning 503 for all requests',
      contactId: jules,
      assigneeId: null,
      source: 'portal',
      priority: 'urgent',
      openedDaysAgo: 0.25,
      path: [],
      thread: [
        {
          daysAgo: 0.25,
          by: 'contact',
          body: 'Everything is down for us — every call to the API comes back 503. This is affecting all of our customers.',
        },
      ],
    },
    {
      id: TICKET_IDS.paused,
      subject: 'Reconciliation report does not match our ledger',
      contactId: cycle(CONTACTS, 1).id,
      assigneeId: USER_IDS.meridianAgent,
      source: 'portal',
      priority: 'high',
      openedDaysAgo: 9,
      path: [{ to: 'pending', daysAgo: 8.9 }],
      thread: [
        {
          daysAgo: 9,
          by: 'contact',
          body: 'Our finance team is seeing a discrepancy of about four hundred entries against the reconciliation report.',
        },
        {
          daysAgo: 8.95,
          by: 'agent',
          body: 'Could you send the ledger export for the same period? I would like to compare row counts before changing anything.',
        },
        {
          daysAgo: 8.9,
          by: 'agent',
          body: 'Waiting on their export. Nothing to do here until it arrives.',
          internal: true,
        },
      ],
    },
    {
      id: TICKET_IDS.deflected,
      subject: 'How do I rotate an API key?',
      contactId: cycle(CONTACTS, 2).id,
      assigneeId: null,
      source: 'widget',
      priority: 'normal',
      openedDaysAgo: 12,
      path: [
        { to: 'resolved', daysAgo: 11.99, by: 'ai' },
        { to: 'closed', daysAgo: 11, by: 'ai' },
      ],
      thread: [
        {
          daysAgo: 12,
          by: 'contact',
          body: 'How do I rotate an API key without downtime?',
        },
        {
          daysAgo: 11.995,
          by: 'ai',
          body: `Mint the replacement first, deploy it, then revoke the old key — both are valid in between, so there is no gap. — ${AI_SIGNATURE}`,
        },
      ],
    },
    {
      // Resolved, reopened, resolved again. The resolution clock resumes rather
      // than resets, so the second resolve is measured against the total active
      // time and not against the reopen — which is the property that stops
      // reopening being a way to launder elapsed time.
      id: TICKET_IDS.reopened,
      subject: 'Scheduled report stopped arriving',
      contactId: cycle(CONTACTS, 3).id,
      assigneeId: USER_IDS.meridianAgentTwo,
      source: 'portal',
      priority: 'normal',
      openedDaysAgo: 20,
      path: [
        { to: 'resolved', daysAgo: 19 },
        { to: 'open', daysAgo: 15 },
        { to: 'resolved', daysAgo: 14 },
      ],
      thread: [
        {
          daysAgo: 20,
          by: 'contact',
          body: 'Our Monday report has not arrived for two weeks.',
        },
        {
          daysAgo: 19.1,
          by: 'agent',
          body: 'The schedule had been paused by a former teammate. I have re-enabled it.',
        },
        {
          daysAgo: 15,
          by: 'contact',
          body: 'It arrived once and then stopped again.',
        },
        {
          daysAgo: 14.2,
          by: 'agent',
          body: 'The recipient list still pointed at a deactivated mailbox. Corrected — you should see it every Monday now.',
        },
        {
          daysAgo: 14.1,
          by: 'agent',
          body: 'Two separate causes, which is why this came back. Worth checking other schedules on this account.',
          internal: true,
        },
      ],
    },
    {
      id: TICKET_IDS.closedWithSuccessor,
      subject: 'Migrating our workspace to the new plan',
      contactId: jules,
      assigneeId: USER_IDS.meridianAgentThree,
      source: 'portal',
      priority: 'normal',
      openedDaysAgo: 30,
      path: [
        { to: 'resolved', daysAgo: 28 },
        { to: 'closed', daysAgo: 26 },
      ],
      thread: [
        {
          daysAgo: 30,
          by: 'contact',
          body: 'We would like to move to the annual plan before renewal.',
        },
        {
          daysAgo: 29.8,
          by: 'agent',
          body: 'Moved you across, with the remaining balance credited. The new term starts today.',
        },
        {
          daysAgo: 28.5,
          by: 'contact',
          body: 'Confirmed on our side, thanks.',
        },
        {
          daysAgo: 28.2,
          by: 'agent',
          body: 'Credit applied manually — finance has the reference.',
          internal: true,
        },
      ],
    },
    {
      // A reply to a closed Ticket does not revive it. It spawns this one, and
      // the chain is what carries the history — which is why `closed` can be
      // genuinely terminal without a customer's follow-up falling on the floor.
      id: randomUUID(),
      subject: 'Migrating our workspace to the new plan',
      contactId: jules,
      assigneeId: USER_IDS.meridianAgentThree,
      spawnedFromTicketId: TICKET_IDS.closedWithSuccessor,
      source: 'portal',
      priority: 'normal',
      openedDaysAgo: 10,
      path: [],
      thread: [
        {
          daysAgo: 10,
          by: 'contact',
          body: 'One more thing on the plan move — the credit does not show on this month’s invoice.',
        },
        {
          daysAgo: 9.9,
          by: 'agent',
          body: 'It lands on the next invoice rather than this one. I have attached the credit note so you have it in the meantime.',
        },
      ],
    },
  ];
};

export const meridian: TenantPlan = {
  id: TENANT_IDS.meridian,
  slug: 'meridian',
  name: 'Meridian',
  // The widget is on for this tenant, so the demo path can exercise it without
  // configuring anything. Two entries because the widget will be embedded on the
  // marketing site and driven from the local dev server, and matching is exact —
  // no wildcards, no subdomain suffixes.
  widgetOrigins: ['https://meridian.example', 'http://localhost:3000'],
  users: USERS,
  contacts: CONTACTS,
  tickets: [...referenceTickets(), ...routineTickets()],
  slack: { teamId: SLACK_TEAM_ID, botUserId: 'U5EED0BOT' },
  serviceToken: {
    id: SERVICE_TOKEN_ID,
    name: 'Deflection assistant',
    // Exactly the support work — the same bound the mint endpoint enforces. A
    // token that could do more than an agent would be a demo of the wrong thing.
    scopes: SUPPORT_WORK,
  },
};
