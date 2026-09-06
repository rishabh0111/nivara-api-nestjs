import { randomUUID } from 'node:crypto';
import {
  CONTACT_IDS,
  SERVICE_TOKEN_IDS,
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

/** One support conversation, played out as a Ticket with a different outcome. */
interface Topic {
  subject: string;
  asked: string;
  answered: string;
  /** What the AI layer says when it handles this alone. */
  deflected: string;
  note: string;
}

/**
 * Forty-four of these, one per routine Ticket below — not a smaller set cycled
 * with repeats.
 *
 * `cycle` still does the assigning, but `TOPICS.length` matches `ROUTINE`'s
 * total exactly, so `index % TOPICS.length` never wraps: every routine Ticket
 * gets a genuinely different customer's words rather than one of a handful of
 * voices said forty-four times over. That property is a count relationship
 * between two arrays that live apart in this file, so it is worth stating
 * here rather than only being true by coincidence — a `SHAPES` change that
 * moves `ROUTINE`'s total without a matching change here would silently bring
 * repeats back.
 */
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
  {
    subject: 'Custom domain for the support portal is not resolving',
    asked:
      'We set up a custom domain for our support portal three days ago and it still shows a certificate error.',
    answered:
      'The CNAME was pointed correctly but the verification TXT record was missing, so the certificate never issued. Added it and the certificate is live.',
    deflected:
      'A missing verification TXT record is the usual cause of a custom domain that never certifies — check the DNS setup guide for the exact record. — ' +
      AI_SIGNATURE,
    note: 'Second account this month with the same missing-TXT mistake. Worth a callout in the setup docs.',
  },
  {
    subject: 'Password reset email never arrives',
    asked:
      'I have requested a password reset three times now and nothing shows up, not even in spam.',
    answered:
      'Your workspace has a corporate mail filter quarantining anything from our sending domain. I have added it to your allowlist and resent the reset.',
    deflected:
      'If a reset email never arrives after several tries, check with your IT team about a mail filter on our sending domain before assuming it failed to send. — ' +
      AI_SIGNATURE,
    note: 'Confirmed via mail headers the sends succeeded; this was entirely on the receiving side.',
  },
  {
    subject: 'Two contact records for the same customer',
    asked:
      'We have two records for the same customer with different histories and want them merged into one.',
    answered:
      'Merged the two contact records — the ticket history from both is now under the older one, and the newer id now redirects.',
    deflected:
      'Duplicate contact records can be merged from the contact detail page; the combined history keeps everything from both. — ' +
      AI_SIGNATURE,
    note: 'Likely caused by a widget session that never picked up the verified email. Flagged for the widget team.',
  },
  {
    subject: 'Slack integration silently stopped posting',
    asked:
      'New tickets used to show up in our Slack channel automatically and now nothing posts, with no error anywhere.',
    answered:
      'The Slack app token had been revoked from your workspace’s side during an app review. Reconnected the integration and it is posting again.',
    deflected:
      'A Slack integration that goes quiet with no error is usually a revoked app token on the Slack side — reconnecting it from the integrations page fixes it. — ' +
      AI_SIGNATURE,
    note: 'Slack revokes tokens silently on some workspace app reviews. Worth a status check we could surface proactively.',
  },
  {
    subject: 'Custom field values missing from the export',
    asked:
      'Our export has all the standard columns but none of the custom fields we added show up.',
    answered:
      'Custom fields need to be added to the export template explicitly — I have updated your saved export to include them.',
    deflected:
      'Custom fields are not included in an export by default; add them to the export template under Settings → Exports before running it. — ' +
      AI_SIGNATURE,
    note: 'This surprises most people who add custom fields after building their export template.',
  },
  {
    subject: 'Auto-assignment rule is not triggering',
    asked:
      'I set up a rule to auto-assign tickets tagged “billing” to one agent, but they are landing unassigned.',
    answered:
      'The rule was scoped to the “Billing” tag with a capital B, while your tickets are tagged lowercase — tags are case-sensitive. Corrected the rule.',
    deflected:
      'Assignment rules match tags exactly, including case — check that the tag in the rule matches the tag on the tickets letter for letter. — ' +
      AI_SIGNATURE,
    note: 'Tag case sensitivity trips people up regularly. Considered a normalisation pass, deferred for now.',
  },
  {
    subject: 'SLA clock seems to run through the weekend',
    asked:
      'A ticket opened Friday evening shows as breached by Saturday morning, which cannot be within our stated hours.',
    answered:
      'Your SLA policy was still on the default 24/7 calendar rather than your configured business hours. Switched it to the business-hours calendar.',
    deflected:
      'If breaches are showing up outside business hours, check that the SLA policy is attached to a business-hours calendar rather than the default 24/7 one. — ' +
      AI_SIGNATURE,
    note: 'Default calendar on new SLA policies should probably follow the workspace calendar automatically. Filed as a product suggestion.',
  },
  {
    subject: 'Canned response variables show as literal text',
    asked:
      'When I use a canned response the {{contact_name}} placeholder is not being replaced — it just sends literally.',
    answered:
      'That canned response was created before variable support shipped and used a different bracket style. Recreated it with the current syntax.',
    deflected:
      'A canned response written before variable support shipped may use an old placeholder style — recreating it with the current double-brace syntax fixes it. — ' +
      AI_SIGNATURE,
    note: 'Old-format canned responses should probably be flagged automatically. Filed as a product suggestion.',
  },
  {
    subject: 'Bulk close only closed part of the selection',
    asked:
      'I selected forty tickets and chose bulk close, but only about half of them actually closed.',
    answered:
      'The tickets that did not close were still `open` rather than `resolved` — bulk close only applies to already-resolved tickets. Resolved and closed the rest for you.',
    deflected:
      'Bulk close only applies to tickets already in a resolved state; an open ticket in the same selection is silently skipped rather than closed. — ' +
      AI_SIGNATURE,
    note: 'The silent skip is the actual problem here, not the underlying rule. Filed for a visible skipped-count in the bulk action result.',
  },
  {
    subject: 'IP allowlist locked out the remote team',
    asked:
      'We turned on an IP allowlist for admin logins and now half our team working from home cannot sign in.',
    answered:
      'Added your team’s VPN exit range to the allowlist so remote logins pass again — the office range alone was too narrow for a hybrid team.',
    deflected:
      'An IP allowlist needs every network your team actually signs in from, including VPN exit ranges for remote staff, not just the office range. — ' +
      AI_SIGNATURE,
    note: 'Recommend testing an allowlist change from a second device before rolling it out to the whole team.',
  },
  {
    subject: 'Sessions time out much faster than expected',
    asked:
      'I am being signed out every twenty minutes or so even though I am actively using the dashboard.',
    answered:
      'A browser extension on your machine was clearing the session cookie on tab focus changes. Disabling it fixed the timeouts.',
    deflected:
      'Unexpectedly frequent sign-outs are usually a browser extension clearing cookies rather than the session timeout itself — try an incognito window to check. — ' +
      AI_SIGNATURE,
    note: 'Third report this quarter traced to an aggressive cookie-clearing extension. Considering a docs page for this.',
  },
  {
    subject: 'An action is missing from the audit log',
    asked:
      'A teammate says they changed a ticket’s priority yesterday but I cannot find that change in the audit log.',
    answered:
      'The change was logged under the ticket’s own history rather than the workspace audit log, since priority changes are ticket-scoped. Found it there.',
    deflected:
      'Some changes, like a ticket’s priority, are logged on the ticket’s own history rather than the workspace-wide audit log — check both. — ' +
      AI_SIGNATURE,
    note: 'Worth reconsidering whether ticket-scoped changes should also surface in the workspace audit log.',
  },
  {
    subject: 'A junior agent has more access than intended',
    asked:
      'One of our newer agents can see billing information that should be admin-only, and we are not sure why.',
    answered:
      'They were added under the general Agent role, which includes billing read access by default. Moved them to a scoped custom role without it.',
    deflected:
      'The default Agent role includes billing read access; if that should not be visible to a specific person, create a custom role without that permission. — ' +
      AI_SIGNATURE,
    note: 'Several accounts assume Agent is the minimal role. Might be worth a narrower default.',
  },
  {
    subject: 'Requesting deletion of a contact’s data',
    asked:
      'A former customer has asked us to delete all of their personal data from our workspace under GDPR.',
    answered:
      'Deleted the contact record and anonymised their name and email across their ticket history, leaving the ticket content itself for our records.',
    deflected:
      'A contact deletion request removes their personal details and anonymises past tickets, while ticket content itself is retained for support records — see the data-handling policy for the exact scope. — ' +
      AI_SIGNATURE,
    note: 'Confirmed against the data-handling policy before acting; logged the request and completion date for the compliance record.',
  },
  {
    subject: 'Calendar integration is creating duplicate events',
    asked:
      'Every scheduled call from a ticket is showing up twice on my calendar after connecting the calendar integration.',
    answered:
      'You had the integration connected on two separate ticket views, so each scheduling action synced twice. Disconnected the duplicate connection.',
    deflected:
      'Duplicate calendar events usually mean the integration is connected in more than one place — check your integrations list for a second, redundant connection. — ' +
      AI_SIGNATURE,
    note: 'The integrations page should probably warn before allowing a second connection to the same calendar.',
  },
  {
    subject: 'Mobile app is not showing push notifications',
    asked:
      'I used to get a push notification for every new assigned ticket on my phone and they stopped a few days ago.',
    answered:
      'Your phone’s OS had revoked notification permission for the app after an update. Re-enabling it in your phone settings restored delivery immediately.',
    deflected:
      'A phone OS update can quietly revoke notification permission for an app — check that permission is still enabled in your phone’s own settings. — ' +
      AI_SIGNATURE,
    note: 'This is an OS-level behaviour on both major platforms after certain updates, not something on our side to fix.',
  },
  {
    subject: 'Filtering by tag returns tickets without that tag',
    asked:
      'Filtering the queue by the tag “urgent-billing” is showing me tickets that clearly are not tagged that way.',
    answered:
      'You had two similarly named tags — “urgent-billing” and “urgent_billing” — and the filter was matching both due to a display quirk. Merged the duplicate tag.',
    deflected:
      'Two similarly spelled tags can look identical in the filter dropdown — check Settings → Tags for a near-duplicate before assuming the filter itself is wrong. — ' +
      AI_SIGNATURE,
    note: 'Filed a suggestion to warn when creating a tag that closely matches an existing one.',
  },
  {
    subject: 'White-label branding is not applying to the portal',
    asked:
      'We uploaded our logo and colours for white-label branding but the support portal our customers see still shows Meridian’s default look.',
    answered:
      'Branding was saved under a draft that was never published. Published it, and the portal now reflects your logo and colours.',
    deflected:
      'Branding changes are saved as a draft until explicitly published — check for an unpublished draft under Settings → Branding if changes are not showing. — ' +
      AI_SIGNATURE,
    note: 'The draft/publish distinction is not obvious from the branding page itself. Filed as a UX suggestion.',
  },
  {
    subject: 'Exported CSV shows garbled accented characters',
    asked:
      'Customer names with accented characters show up as garbled symbols when we open the exported CSV in our spreadsheet tool.',
    answered:
      'The export is UTF-8 and your spreadsheet tool was opening it with a different default encoding. Re-importing with UTF-8 selected explicitly fixed the display.',
    deflected:
      'Garbled accented characters in an exported CSV usually mean the spreadsheet tool opened it with the wrong encoding — re-import and select UTF-8 explicitly. — ' +
      AI_SIGNATURE,
    note: 'Some spreadsheet tools default to a legacy encoding on CSV import; worth a short note in the export docs.',
  },
  {
    subject: 'API pagination cursor expires before we finish paging',
    asked:
      'A long-running export job of ours gets a cursor-expired error partway through paging results.',
    answered:
      'Your job was pausing for several minutes between pages under heavy load, past the cursor’s validity window. Adjusted your job to keep requests closer together, which resolved it.',
    deflected:
      'A pagination cursor is only valid for a limited window — a job that pauses too long between pages under load can outlive it and needs a fresh query instead. — ' +
      AI_SIGNATURE,
    note: 'Cursor lifetime is not currently documented anywhere customer-facing. Flagged for the API reference.',
  },
  {
    subject: 'An escalation rule never fires',
    asked:
      'We set up a rule to escalate any urgent ticket unanswered after fifteen minutes, but nothing has ever escalated even when it should have.',
    answered:
      'The rule’s condition compared against the wrong timestamp field, so it was evaluating against ticket creation rather than assignment. Corrected the field and it is firing correctly.',
    deflected:
      'An escalation rule that never fires is often comparing against the wrong timestamp field — check that it is evaluating time since assignment rather than time since creation. — ' +
      AI_SIGNATURE,
    note: 'Considering a dry-run mode for escalation rules so a misconfigured condition is visible before it goes live.',
  },
  {
    subject: 'Support portal shows the wrong language for some visitors',
    asked:
      'Some of our customers in France are seeing the support portal in English even though we have French translations enabled.',
    answered:
      'Locale detection was reading the browser’s primary language, and some of your affected customers have English set as primary with French second. Added a manual language switcher to the portal.',
    deflected:
      'Automatic locale detection reads a visitor’s primary browser language, which is not always their preferred one — a manual language switcher on the portal covers that gap. — ' +
      AI_SIGNATURE,
    note: 'Manual switcher shipped as a portal setting; recommend enabling it for any workspace supporting more than one locale.',
  },
  {
    subject: 'Need to restore workspace settings after a bad change',
    asked:
      'Someone on our team changed several workspace settings by mistake this morning and we want to revert to how things were configured yesterday.',
    answered:
      'Workspace settings do not currently support a bulk restore, but I was able to walk back each changed setting individually using the audit log as a reference.',
    deflected:
      'There is no one-step settings restore; the audit log records each setting change individually and is the fastest way to walk changes back by hand. — ' +
      AI_SIGNATURE,
    note: 'A one-step settings restore keeps coming up. Worth raising with product as a recurring request.',
  },
  {
    subject: 'An installed integration will not finish setup',
    asked:
      'We are trying to install the calendar app from the integrations marketplace and it gets stuck on the authorization step every time.',
    answered:
      'Your browser’s third-party cookie blocking was breaking the authorization popup. Installing with third-party cookies temporarily allowed for our domain let it complete.',
    deflected:
      'An integration install stuck on the authorization step is usually third-party cookie blocking in the browser — temporarily allowing it for our domain during install resolves it. — ' +
      AI_SIGNATURE,
    note: 'This will get more common as browsers tighten third-party cookie defaults. Worth an OAuth flow that does not depend on them.',
  },
  {
    subject: 'One customer email created two separate tickets',
    asked:
      'A customer says they only sent one email but we ended up with two tickets from it, and they are confused getting two replies.',
    answered:
      'Their email client had sent it with two recipients on our support address in different capitalisations, which our inbound matching treated as distinct. Merged the two tickets and normalised the matching rule.',
    deflected:
      'A single email landing as two tickets is usually an inbound-matching quirk — check for the same address in different capitalisation or with a plus-alias before assuming it duplicated on send. — ' +
      AI_SIGNATURE,
    note: 'Inbound matching should probably normalise case before deduplicating. Filed as a fix.',
  },
  {
    subject: 'File attachment upload fails with no error shown',
    asked:
      'When I try to attach a file to a reply, the upload bar just sits there and nothing happens, no error at all.',
    answered:
      'The file was just over the size limit, and the uploader was failing to surface that as a visible error. Compressing it let the upload succeed.',
    deflected:
      'An attachment upload that silently hangs is almost always over the size limit — compressing the file or splitting it usually resolves it. — ' +
      AI_SIGNATURE,
    note: 'The silent failure on an oversized file is the real bug here. Filed to surface a visible error instead.',
  },
  {
    subject: 'Scheduled report lands an hour off from expected',
    asked:
      'Our weekly report is set to send at 9am but keeps arriving at 8am, and we cannot figure out why.',
    answered:
      'The report schedule was set in UTC rather than your workspace timezone, and daylight saving had shifted the apparent local send time. Reconfigured it to follow the workspace timezone.',
    deflected:
      'A scheduled report that drifts by an hour around a daylight-saving change is usually scheduled in UTC rather than the workspace timezone — reconfigure it to follow the workspace setting. — ' +
      AI_SIGNATURE,
    note: 'Report scheduling should probably default to the workspace timezone rather than UTC. Filed as a product suggestion.',
  },
  {
    subject: 'SSO group mapping is not assigning the right role',
    asked:
      'New staff coming in through SSO are all landing with the default role instead of the role their identity-provider group should map to.',
    answered:
      'The group-to-role mapping referenced the group’s display name, which your identity provider had since renamed; mappings match on the group id. Updated the mapping to the current id.',
    deflected:
      'Group-to-role mapping matches on the identity provider’s group id, not its display name — if a group was renamed on the provider side, the mapping needs updating to the current id. — ' +
      AI_SIGNATURE,
    note: 'Matching on display name instead of id is a common expectation. Worth a clearer warning in the mapping UI.',
  },
  {
    subject: 'Rate limit is shared unexpectedly between two keys',
    asked:
      'We mint two separate API keys for two services and both are hitting rate limits as if they share one ceiling.',
    answered:
      'Both keys had been minted under the same integration record, and the rate limit is scoped to the integration rather than the individual key. Split them into two separate integrations.',
    deflected:
      'A rate limit ceiling is scoped to the integration a key belongs to, not the key itself — two keys under one integration record share the limit even though they look separate. — ' +
      AI_SIGNATURE,
    note: 'This is the second report of the integration-vs-key scoping being unintuitive. Worth documenting explicitly.',
  },
  {
    subject: 'Tickets imported from Slack are missing some replies',
    asked:
      'A thread we imported from an old Slack channel is missing a couple of replies that I know were posted.',
    answered:
      'Those replies were posted as Slack thread reactions rather than text messages, which the importer does not carry across. Added the missing content manually from the export you shared.',
    deflected:
      'A Slack import carries text replies but not reactions or thread-only emoji responses — anything conveyed only as a reaction will not appear in the imported thread. — ' +
      AI_SIGNATURE,
    note: 'Reaction-only replies are a known importer gap. Documented rather than silently accepted as complete.',
  },
  {
    subject: 'Merging two tickets scrambled the message order',
    asked:
      'I merged two related tickets and now the combined thread shows replies out of chronological order.',
    answered:
      'The merge interleaves by each ticket’s own internal sequence rather than timestamp when two messages share the same recorded second. Reordered the thread by timestamp manually.',
    deflected:
      'A ticket merge normally orders the combined thread by timestamp; two messages recorded in the same second can occasionally interleave out of order and may need a manual check. — ' +
      AI_SIGNATURE,
    note: 'Rare enough to not have been caught before — sub-second ordering during merge is the actual fix needed.',
  },
  {
    subject: 'Usage dashboard undercounts calls from a partner integration',
    asked:
      'Our own logs show far more API calls going out than the usage dashboard reports for this month.',
    answered:
      'Calls made through your partner integration’s shared service account were being attributed to the partner’s workspace rather than yours. Corrected the attribution and backfilled the dashboard.',
    deflected:
      'A usage dashboard that undercounts against your own logs is often a partner integration calling through a shared service account attributed elsewhere — worth checking with the partner how their account is set up. — ' +
      AI_SIGNATURE,
    note: 'Attribution should follow the originating workspace regardless of which service account makes the call. Filed as a billing-accuracy fix.',
  },
];

/**
 * The routine backlog, as a table of shapes rather than fifty literals.
 *
 * Each name describes what the Ticket demonstrates, and the counts are the
 * distribution: a queue that is mostly settled work with live work on top, which
 * is what a real support inbox looks like and what makes the analytics figures
 * mean anything.
 *
 * The values below must sum to `TOPICS.length` (see that array's comment) —
 * changing the total here without adding or removing a matching number of
 * Topics brings back repeated phrasing in the routine backlog.
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
  // configuring anything. Matching is exact — no wildcards, no subdomain
  // suffixes — so every page the widget is embedded on is listed.
  //
  // The first two are the marketing site and the local dev server. The last two
  // are the published widget demo: a static page standing in for a tenant's own
  // site, and the local server that serves that same page during development.
  // Note its port — the widget's whole claim is that it works from somebody
  // else's page, so the local host page is served on its own port rather than
  // the front end's, which would make the demonstration same-origin and prove
  // nothing about the gate it is meant to be passing.
  //
  // Both demo origins are listed here *and* on Sortwood, because two demo pages
  // are served from each of them and they bootstrap different tenants. The one
  // that answers points here — an embedded widget mints Contacts and opens
  // Tickets on whatever tenant it is bootstrapped against, so the showcase
  // gains real widget traffic beside its composed backlog, which is the point:
  // the AI layer answers on this tenant and deflection is read from this
  // tenant's analytics. The isolation page points at Sortwood. An origin is not
  // a tenant, and the allowlist was never a partition of one.
  //
  // These five are the live rows. The Vercel entry is the deployed front end's
  // own origin, which `/widget` is served from; it was added to the running
  // database by hand and is written down here so that a reseed restores the
  // deployment rather than quietly 403-ing it.
  widgetOrigins: [
    'https://meridian.example',
    'http://localhost:3000',
    'https://rishabh0111.github.io',
    'http://localhost:4173',
    'https://nivara-web-nextjs.vercel.app',
  ],
  users: USERS,
  contacts: CONTACTS,
  tickets: [...referenceTickets(), ...routineTickets()],
  slack: { teamId: SLACK_TEAM_ID, botUserId: 'U5EED0BOT' },
  assistantToken: {
    id: SERVICE_TOKEN_IDS.assistant,
    name: 'Deflection assistant',
    // Four of the eleven, and the gap is the statement. `ASSIGNABLE_SCOPES` is
    // the support work, and it is the bound on what a machine credential *may*
    // hold — not a shopping list of what one should take. This credential reads
    // a Ticket, replies to it, moves it, and writes an internal Note; that is
    // the whole job, so that is the whole grant.
    //
    // The omissions are each somebody's decision rather than an oversight, and
    // `note:read` is the one worth naming: a layer that can write an internal
    // Note but never read one cannot be talked into surfacing a colleague's
    // private note into an answer a customer sees.
    scopes: ['ticket:read', 'ticket:reply', 'ticket:transition', 'note:write'],
  },
  reporterToken: {
    id: SERVICE_TOKEN_IDS.reporter,
    name: 'Deflection reporter',
    // `analytics:read` alone, held by the scheduled job that publishes the
    // score and by nothing on the request path. Adding it to the assistant
    // above would have saved a row and cost the arrangement its meaning: the
    // credential that answers customers would then be able to read the numbers
    // those answers are graded on.
    scopes: ['analytics:read'],
  },
};
