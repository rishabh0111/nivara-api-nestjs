# Nivara Desk

A multitenant, two-sided customer-support helpdesk API. Every concept below lives inside exactly one **Tenant**, and tenant identity is always server-determined, never taken from client input.

## Language

### Tenancy & identity

**Tenant**:
The isolation boundary. Every other record belongs to exactly one Tenant, and no record is ever visible across Tenants. Meridian is the primary seed Tenant, not the system itself.
_Avoid_: Organization, workspace, account, company.

**User**:
An internal staff member of one Tenant — the subject of role-based access control. Invite-provisioned and OAuth-authenticated. A User belongs to exactly one Tenant; the same real person working for two Tenants is two Users.
_Avoid_: Agent (that's a role, not the entity), staff, member, account.

**Role**:
A User's authority within their Tenant: `agent` or `admin`.
_Avoid_: Permission (that's the finer-grained thing a Role grants), group.

**Contact**:
The tenant's end customer — the party a Ticket is *from*. Every Ticket has exactly one Contact as its requester. A Contact persists across conversations; it may be unverified (created from an anonymous widget visitor) or verified. A verified Contact holds a portal credential and signs in at the **Portal**; most Contacts hold none at all, because a widget visitor becomes a Contact without ever authenticating.
_Avoid_: Customer, requester, end-user, client, lead.

**Portal**:
The signed-in customer surface, and the second **access axis** beside staff Roles. A Contact authenticating there resolves to a Contact principal, which holds *no* Permission from the staff catalog — its reach is row ownership ("the Tickets I requested"), enforced by row-level security rather than by a grant. Being a customer is therefore not a weaker form of being an agent: the two axes answer different questions and neither is a subset of the other.
_Avoid_: Customer portal (redundant), self-service, help centre.

**WidgetSession**:
An ephemeral, HMAC-signed, anonymous handle minted for a visitor on a Tenant's own site. It resolves to (or creates) a Contact but carries no persistent credential of its own. The seam between a WidgetSession and a lasting Contact identity is deliberately left open — merging one person's identity across sessions is a later concern.
_Avoid_: Guest, anonymous user, visitor token.

### Tickets & conversation

**Ticket**:
The unit of support work. It has a requester (Contact), an optional single assignee (User), a state, a priority, and an originating source.
_Avoid_: Case, issue, conversation, request.

**Source**:
The channel a Ticket originated on: `portal`, `widget`, or `slack`. It is fixed at creation and records where the conversation *started*, which is deliberately not the same question as where the Ticket can be reached now — see **Reply route**.
_Avoid_: Channel (overloaded), origin, medium.

**Reply route**:
Where a Ticket is reachable outside Nivara, and null for the great majority, which are already where the customer is reading. A property of the conversation rather than of any one Message, set when the Ticket is created and immutable afterwards — re-pointing a live conversation would send every future reply to a thread the customer is not watching, and the replies would still look delivered. A spawned Ticket inherits its parent's route from the database, so no code path can create a Ticket that is silently unreachable.
_Avoid_: Destination (that is the delivery's word), address, endpoint, channel.

**SlackInstallation**:
The record that a Slack workspace belongs to a Tenant, and the only thing that may answer that question. An inbound event's workspace is authenticated by the signature check before it is read as anything; the payload's own claims about who it belongs to are never consulted. It deliberately holds no credential, because resolving a workspace happens *before* any Tenant is known and therefore under a cross-tenant read.
_Avoid_: Connection, integration (that is the category), app, workspace (that is Slack's word for the thing being mapped).

**Priority**:
A Ticket's urgency: `low`, `normal`, `high`, or `urgent`. SLA targets are keyed off it.
_Avoid_: Severity, importance.

**Assignee**:
The single User currently responsible for a Ticket. A Ticket may be unassigned. There are no teams or groups in the model.
_Avoid_: Owner, handler.

**Message**:
A customer-visible entry in a Ticket's thread, authored by a Contact, a User, or the system.
_Avoid_: Reply, comment, post.

**Note**:
An agent-only internal entry on a Ticket, authored by a User and never visible to a Contact. It is a separate entity from Message — invisibility to customers is a structural fact, not a flag.
_Avoid_: Internal comment, private message, annotation.

### Machine access, SLA, audit, analytics

**ServiceToken**:
A tenant-scoped, non-human credential (used by the AI layer) carrying a set of scopes. It authenticates a machine caller, not a User.
_Avoid_: API key (unqualified), bot user, app.

**SLA**:
A per-Tenant policy of first-response and resolution targets by Priority, tracked per Ticket as two clocks measured on a 24/7 wall-clock — there are no business-hours calendars. Targets are one canonical matrix seeded identically for every Tenant and not editable through the API in v1; Priority is the sole key, so the deadline is predictable from it alone. **First response** runs from creation until the first customer-visible Message authored by a User or ServiceToken — a Note or a state change never satisfies it — and it **never pauses**, in any state: a Ticket parked in `pending` with nobody having answered it is still a Ticket nobody has answered. **Resolution** is anchored at creation and pauses only in `pending`; `on_hold` keeps running, so internal blockers stay visible as elapsed time. A reopen **resumes** that clock rather than resetting it, so reopening cannot erase elapsed time.
_Avoid_: Deadline, timer (in isolation).

**Breach**:
A missed SLA target, recorded as a **set-once sticky latch** on the Ticket that is never cleared — it survives a late reply and a reopen, because a breach that happened stays recorded. It fires an **escalation**, which is strictly *notify, don't mutate*: the latch, an audit row attributed to `system`, and a `ticket.sla.breached` event to the Tenant's agents room. It never changes the Ticket's Priority or assignee — bumping Priority would retroactively change the target the Ticket is scored against, since Priority is the sole SLA key.
_Avoid_: Violation, miss, SLA failure, escalation (as a state).

**Dwell**:
Settling abandoned work after a fixed seven days of silence: a `pending` Ticket resolves itself, and a `resolved` Ticket closes itself. Silence is measured on a Ticket's last activity — a transition, an assignment, a priority change, a Message or a Note — which is tracked separately from `updatedAt`, since a customer's reply is activity that touches no column on the Ticket.
_Avoid_: Auto-close, stale, timeout, expiry.

**AuditLog**:
An append-only record of actions taken within a Tenant, attributing each action to an actor (User, Contact, ServiceToken, or system) and the entity it touched. Control-plane only: it records changes to state and configuration, never conversation — Message and Note content is domain data, attributed on its own rows. Append-only is a property of the table rather than a convention: UPDATE and DELETE are refused by Postgres, and a write with no actor in context fails rather than defaulting to `system`.
_Avoid_: History, event log, activity feed.

**Analytics**:
A read model computed over Tickets, Messages, and SLA clocks (deflection rate, resolution rate, response times, SLA breach rate) — per Tenant. It defines no base entity of its own.
_Avoid_: Reporting, metrics store, warehouse.

### Scheduled work

**IdempotencyRecord**:
A claim on a caller-supplied key, held so that a retried request takes effect at most once. It is claimed before the guarded work runs and settled after, and is the only thing in the system that answers "has this exact request already happened?". Identified by Tenant, **scope** and key: the scope names both the kind of thing being deduplicated and — for an API caller — *which principal* is retrying, so two callers can never address each other's records. Two consumers share one table: a side-effecting `POST` carrying `Idempotency-Key`, and inbound event dedupe keyed on a source's own event id, which compares no payload because at-least-once redelivery makes no promise of an identical envelope. A completed record replays its original response verbatim; one still in flight refuses a duplicate as retryable rather than answering it. Honoured for 24 hours, after which the key is claimable again — enforced when a key is claimed, not merely by the sweep that reclaims the space.
_Avoid_: Cache, dedupe table, request log, replay (as an entity), expiry (the window is *retention*).

**Job**:
One unit of externally-fallible work, held as a row in Postgres so it survives a restart of the process that queued it. It carries a `kind` routing it to a handler, a payload of *references* rather than content, and a `runAfter` that is simultaneously its schedule and its backoff — a retry is a later `runAfter`, never a worker holding a wait open. Enqueued inside the transaction whose change warranted it, so a Job can never exist for a write that rolled back. Exhausting its attempts makes it `dead`, which is terminal and notifies rather than mutates.
_Avoid_: Task, message, queue item, event (that is the real-time envelope).

**OutboundDelivery**:
One customer-visible Message on its way to one destination, and the answer to "did this reply reach the customer". It is emphatically *not* a retry state machine — retry, backoff and giving up all live on the **Job**, identically for every kind of externally fallible work. What this owns is the half a queue cannot: **at-most-once posting**, since delivery is at-least-once by construction and a process killed between posting and settling would otherwise double-post into a customer's thread on every restart. Keyed by Message *and* destination, because delivering one reply to two places is two deliveries while two attempts at one place is a duplicate. Reaching `dead` notifies and mutates nothing.
_Avoid_: Webhook (there is no tenant-facing subscription surface), send, dispatch (that is the act), notification.

**Drain**:
The fast tick, claiming due Jobs across every Tenant at once with `SELECT … FOR UPDATE SKIP LOCKED` and running each handler back inside its own Tenant's context. The claim is the one query in the system that crosses Tenants, and mutual exclusion is a property of that statement rather than of a lock — so two drainers, in one process or two, never take the same Job and never wait for each other.
_Avoid_: Worker, consumer, poller.

**Sweep**:
The slow tick, and the sole firer of every effect triggered by the *absence* of an event — an SLA breach, a Ticket dwelling untouched for seven days. Such effects have no write to ride, so something has to go and look. A Sweep acts directly in its own transaction rather than enqueueing, because its effects touch only Postgres and so have nothing to retry; fire-once lives in its SQL predicates (a set-once latch, a from-to transition guard), never in a lock, which is what makes running it twice indistinguishable from running it once.
_Avoid_: Cron, batch, reconciliation.

### Real-time

**Room**:
The unit of real-time subscription, and the form tenant isolation takes on a socket. Every Room name carries its Tenant (`t:<tenant>:…`), so deciding whether a principal may join one is a string comparison rather than a lookup. There are exactly three: the staff dashboard firehose, a Ticket's customer-visible thread, and that thread's staff-only `:internal` sibling — which is the structural half of Note invisibility, the half that does not depend on a filter being right.
_Avoid_: Channel (overloaded with Source), topic, subscription.

**Envelope**:
The single wire shape every real-time event takes — `{ event, room, seq, ts, data }` — identical across the event set and deliberately free of any transport's concepts, so the contract survives a port to another framework. Documented at `docs/realtime/SCHEMA.md`, which *is* the contract `nivara-web` consumes rather than a description of one.
_Avoid_: Payload (that is `data` alone), frame, packet.

**Sequence**:
A Room's monotonic counter, carried as `seq`. It is the ordering authority within a Room — `ts` is not — and the pair `(room, seq)` is what a client dedupes on, because delivery is at-least-once. Monotonic but deliberately not contiguous: an event withheld from a customer leaves its number unused rather than renumbering, so two principals watching one Room agree about what happened.
_Avoid_: Offset, version, cursor (that is the client's position, not the number).

**Replay**:
What a reconnecting client is given for what it missed, from a bounded per-Room buffer and filtered by the same audience rules that governed live delivery. Bounded means the answer is sometimes "I cannot tell you", and that is reported as a gap rather than hidden behind a short list — a client told it is caught up when it is not is the failure this exists to prevent.
_Avoid_: Backfill, catch-up, history (that is the AuditLog).
