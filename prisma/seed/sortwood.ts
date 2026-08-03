import { randomUUID } from 'node:crypto';
import {
  CONTACT_IDS,
  SHARED_EMAIL,
  SHARED_GOOGLE_SUBJECT,
  TENANT_IDS,
  USER_IDS,
} from './anchors';
import { TenantPlan } from './plan';

/**
 * Sortwood: the tenant that exists so isolation can be checked rather than
 * believed.
 *
 * One tenant makes isolation unfalsifiable. Every query returns the only rows
 * there are, and a policy that did nothing at all would look identical to one
 * that worked — including to the developer evaluating this API, who has no way
 * to tell the difference from the outside.
 *
 * So there is a second tenant, and it is deliberately small. Its job is not to
 * be a second showcase: it is to be few enough rows that somebody can sign in as
 * Sortwood's admin, look at the whole queue, and see for themselves that
 * Meridian's fifty Tickets are not in it. Five Tickets is a number a person can
 * hold in their head; fifty is a number they have to trust a count of.
 */

const CONTACTS = [
  {
    id: CONTACT_IDS.sortwoodSam,
    email: 'sam@example.test',
    name: 'Sam Whitlock',
    verified: true,
  },
  {
    id: randomUUID(),
    email: 'nell@example.test',
    name: 'Nell Ashworth',
    verified: true,
  },
  {
    id: randomUUID(),
    email: 'gus@example.test',
    name: 'Gus Lindqvist',
    verified: false,
  },
];

/**
 * Five Tickets across four states, one per source, and one already breached.
 *
 * Small, but not a toy: the point of the isolation tenant is that a developer
 * can ask it every question they asked Meridian and get a different answer, so
 * it has to have enough shape for those questions to be meaningful.
 */
const tickets = () => {
  const [sam, nell, gus] = CONTACTS;

  return [
    {
      id: randomUUID(),
      subject: 'Password reset email never arrives',
      contactId: sam.id,
      assigneeId: USER_IDS.sortwoodAgent,
      source: 'portal' as const,
      priority: 'high' as const,
      openedDaysAgo: 3,
      path: [],
      thread: [
        {
          daysAgo: 3,
          by: 'contact' as const,
          body: 'I have asked for a reset link four times and nothing has come through.',
        },
        {
          daysAgo: 2.95,
          by: 'agent' as const,
          body: 'Your address was on a bounce suppression list from an earlier delivery failure. I have cleared it — try once more.',
        },
      ],
    },
    {
      id: randomUUID(),
      subject: 'Can we add a second admin?',
      contactId: nell.id,
      assigneeId: USER_IDS.sortwoodAgent,
      source: 'widget' as const,
      priority: 'normal' as const,
      openedDaysAgo: 6,
      path: [{ to: 'pending' as const, daysAgo: 5.9 }],
      thread: [
        {
          daysAgo: 6,
          by: 'contact' as const,
          body: 'We would like a second person with admin rights. Who do we ask?',
        },
        {
          daysAgo: 5.95,
          by: 'agent' as const,
          body: 'Your existing admin can invite them from Settings → Team and choose the admin role. Let me know who it should be if you would rather we did it.',
        },
      ],
    },
    {
      // Unanswered and well past its first-response target, so the isolation
      // tenant has a breached clock of its own — otherwise "SLA works" would be
      // a claim only one tenant's data supports.
      id: randomUUID(),
      subject: 'Billing charged us twice this month',
      contactId: gus.id,
      assigneeId: null,
      source: 'portal' as const,
      priority: 'urgent' as const,
      openedDaysAgo: 1.5,
      path: [],
      thread: [
        {
          daysAgo: 1.5,
          by: 'contact' as const,
          body: 'There are two identical charges on our card for this month.',
        },
      ],
    },
    {
      id: randomUUID(),
      subject: 'Where do I find the changelog?',
      contactId: nell.id,
      assigneeId: USER_IDS.sortwoodAdmin,
      // `portal` rather than `slack`, deliberately. Sortwood has no Slack
      // installation — that placeholder is Meridian's — and the installation row
      // *is* the workspace-to-tenant routing table, so a Slack-sourced Ticket
      // here would be one the ingestion path could not have produced and whose
      // reply-back would have nowhere to go. Data that no code path can reach is
      // the kind of seed that teaches a reader something untrue.
      source: 'portal' as const,
      priority: 'low' as const,
      openedDaysAgo: 14,
      path: [{ to: 'resolved' as const, daysAgo: 13.5 }],
      thread: [
        {
          daysAgo: 14,
          by: 'contact' as const,
          body: 'Is there a changelog anywhere? We keep missing new features.',
        },
        {
          daysAgo: 13.8,
          by: 'agent' as const,
          body: 'It is published under Product → Changelog, and there is an RSS feed if you would rather subscribe.',
        },
      ],
    },
    {
      id: randomUUID(),
      subject: 'Cancelling one of our seats',
      contactId: sam.id,
      assigneeId: USER_IDS.sortwoodAgent,
      source: 'portal' as const,
      priority: 'normal' as const,
      openedDaysAgo: 21,
      path: [
        { to: 'resolved' as const, daysAgo: 20.5 },
        { to: 'closed' as const, daysAgo: 18 },
      ],
      thread: [
        {
          daysAgo: 21,
          by: 'contact' as const,
          body: 'One of our team has left. Can we drop to three seats at renewal?',
        },
        {
          daysAgo: 20.7,
          by: 'agent' as const,
          body: 'Done — the seat count drops at renewal and the prorated difference is credited then.',
        },
        {
          daysAgo: 20.6,
          by: 'agent' as const,
          body: 'Downgrade scheduled rather than applied immediately, so nothing changes mid-term.',
          internal: true,
        },
      ],
    },
  ];
};

export const sortwood: TenantPlan = {
  id: TENANT_IDS.sortwood,
  slug: 'sortwood',
  name: 'Sortwood',
  // A *different* origin from Meridian's, which is what makes the allowlist
  // demonstrable rather than merely present: a page allowed to bootstrap one
  // tenant's widget is refused by the other, and the isolation tenant proves it
  // the same way it proves every other cross-tenant claim.
  //
  // One entry, and the demo's own origins are not among them: the embedded
  // widget bootstraps Meridian, so they are listed there. What this tenant owes
  // the demonstration is an origin Meridian does *not* allow, so that a refusal
  // is attributable to the tenant rather than to an origin no tenant has heard
  // of — which any unlisted string would have shown just as well.
  widgetOrigins: ['https://sortwood.example'],
  // An admin and an agent, which is all a tenant this size needs — plus the
  // shared-address User, which is not staffing but evidence. Iris exists here
  // *and* at Meridian on the same address, and the pair is the only way to show
  // that identity in this system is tenant-local (ADR-0001) rather than global.
  users: [
    {
      id: USER_IDS.sortwoodAdmin,
      email: 'admin@sortwood.test',
      name: 'Petra Lindqvist',
      role: 'admin',
    },
    {
      id: USER_IDS.sortwoodAgent,
      email: 'agent@sortwood.test',
      name: 'Otto Reyes',
      role: 'agent',
    },
    {
      // The other half of the shared-address pair, carrying the *same* Google
      // subject as Meridian's Iris. That is the claim worth making visible: one
      // Google account, two Users, two rows, and a unique index that is per
      // tenant rather than global so both may exist. A globally unique index
      // would make this seed fail, which is the check being cashed here.
      id: USER_IDS.sortwoodDual,
      email: SHARED_EMAIL,
      name: 'Iris Vance',
      // `admin` here against `agent` at Meridian. Matching roles would have made
      // the pair indistinguishable in everything but the id; differing ones mean
      // a sign-in that resolved the wrong row shows it in the role it hands back,
      // which is what `auth.int-spec.ts` asserts.
      role: 'admin',
      googleSubject: SHARED_GOOGLE_SUBJECT,
    },
  ],
  contacts: CONTACTS,
  tickets: tickets(),
};
