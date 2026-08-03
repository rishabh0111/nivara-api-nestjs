import { Permission } from '../../src/authz/permissions';
import {
  TicketPriority,
  TicketSource,
  TicketState,
} from '../../src/generated/prisma/client';

/**
 * What a seeded tenant is, as data.
 *
 * The plan is deliberately inert: it names rows and the order things happened
 * in, and knows nothing about Prisma, triggers or SQL. `write.ts` is the only
 * file that does. That split is what keeps the showcase editable — adding a
 * Ticket to the demo should be adding an object to a list, not learning which
 * columns a trigger will overwrite.
 *
 * Times are **days before the run**, never absolute. A seed with a date in it
 * ages: run it in six months and the SLA clocks are all breached, the analytics
 * window is empty, and the demo shows a dead queue. Expressing everything as an
 * offset means the showcase is the same age whenever it is built.
 */

/** Days before the run, as a number so arithmetic on the timeline reads plainly. */
export type DaysAgo = number;

/** One thing somebody said on a Ticket. */
export interface ThreadEntry {
  daysAgo: DaysAgo;

  /**
   * Who said it, in the vocabulary the database stamps rather than the one a
   * reader might reach for. `ai` becomes a `service` actor, which is the whole
   * mechanism behind deflection: the analytics predicate asks whether any
   * `user` wrote on the Ticket, so an AI reply is invisible to it by being
   * attributed honestly rather than by being flagged.
   */
  by: 'contact' | 'agent' | 'ai';

  body: string;

  /**
   * An internal Note instead of a customer-visible Message.
   *
   * Only meaningful on an `agent` entry — a Contact cannot write a Note, and an
   * AI one would make the Ticket un-deflected for a reason nobody could see on
   * the thread. Notes also do not satisfy the first-response clock, which is
   * exactly the asymmetry a demo should show.
   */
  internal?: boolean;
}

/** A move through the state machine, and when it happened. */
export interface Transition {
  to: TicketState;
  daysAgo: DaysAgo;

  /**
   * Who moved it. Defaults to a person — the assignee if there is one, and the
   * tenant's admin otherwise.
   *
   * `ai` is here for the deflected Tickets, where the AI layer both answered and
   * resolved. Attributing those transitions to a person would put a `user` actor
   * in the audit log for work no person did, and the audit log is the one place
   * a demo must not lie about who acted.
   */
  by?: 'agent' | 'ai';
}

export interface TicketPlan {
  id: string;
  subject: string;
  contactId: string;

  /**
   * Null for the untriaged and for everything the AI handled alone. There is no
   * `new` state and no `deflected` flag — "nobody owns this" is this column
   * being null, and the demo should show that rather than work around it.
   */
  assigneeId: string | null;

  source: TicketSource;
  priority: TicketPriority;
  openedDaysAgo: DaysAgo;

  /** The moves after birth. Every Ticket is born `open`; none of these say so. */
  path: readonly Transition[];

  thread: readonly ThreadEntry[];

  /** The closed Ticket whose later reply produced this one. */
  spawnedFromTicketId?: string;

  /**
   * Where a `slack` Ticket's replies go back to.
   *
   * Both halves or neither — a channel with no thread would deliver replies into
   * a channel's top level rather than to the person who asked, and the schema
   * refuses the half-route rather than trusting writers to remember.
   */
  slackRoute?: { channelId: string; threadTs: string };
}

export interface UserPlan {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'agent';

  /**
   * A stand-in for Google's `sub` claim, on the few Users that carry one.
   *
   * It shows the *data shape* Google sign-in produces without Google being
   * configured, which is the only part of that path a key-free run can show.
   */
  googleSubject?: string;
}

export interface ContactPlan {
  id: string;
  /** Null for the widget-born Contact who never said who they are. */
  email: string | null;
  name: string | null;
  verified: boolean;
}

/**
 * One machine credential, and what it was granted at mint.
 *
 * The scopes are `Permission`s rather than strings, which is the one place this
 * file reaches into the application's vocabulary on purpose: a seed granting a
 * scope that does not exist would write a row whose authority silently narrows
 * to nothing when `grantedScopes()` reads it back, and a typo should fail at the
 * compiler instead.
 */
export interface ServiceTokenPlan {
  id: string;
  name: string;
  scopes: readonly Permission[];
}

export interface TenantPlan {
  id: string;
  slug: string;
  name: string;
  widgetOrigins: readonly string[];
  users: readonly UserPlan[];
  contacts: readonly ContactPlan[];
  tickets: readonly TicketPlan[];

  /**
   * A workspace record with no credential beside it.
   *
   * The row is the routing table Slack ingestion reads — workspace id to tenant
   * — and it is safe to seed because it holds no secret by design. The bot token
   * lives in configuration, so an unconfigured tenant has an installation that
   * simply does not deliver, which is the dormant-when-unconfigured behaviour
   * every optional integration here has.
   */
  slack?: { teamId: string; botUserId: string };

  /**
   * The machine credential the AI layer acts with, and the one every `ai` entry
   * in this tenant's threads is attributed to.
   *
   * A tenant has at most one, because "which credential wrote this reply" has
   * to have a single answer for the deflection story to hold together.
   */
  assistantToken?: ServiceTokenPlan;

  /**
   * A second machine credential that only reads, held by whatever job reports
   * on the tenant rather than by anything on the request path.
   *
   * Two named fields rather than a list, because the two are not
   * interchangeable: `write.ts` has to know which one seeded `ai` replies were
   * written under, and a list would make that a search. Why they are two
   * credentials at all is in `anchors.ts`.
   */
  reporterToken?: ServiceTokenPlan;
}
