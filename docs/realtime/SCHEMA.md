# Nivara Desk — real-time wire contract

This document **is** the contract `nivara-web` consumes. It is not a description of an implementation; the implementation is required to match it. The OpenAPI document covers the HTTP surface and says nothing about this one, so a change here is a change to a published interface and is versioned by the same rule the error catalog uses: adding an event is additive, renaming or removing one is breaking.

Everything below is framework-neutral. Socket.IO is the transport in the Nest implementation, and nothing in the envelope, the room grammar, or the delivery semantics is a Socket.IO concept — the Spring and FastAPI ports re-implement the same semantics over their own server libraries and a client cannot tell which one it is talking to.

---

## 1. Connecting

| | |
| --- | --- |
| Namespace | `/rt` |
| Transport | WebSocket (Socket.IO client, default upgrade path) |
| Credential | presented once, in the handshake `auth` payload as `token` |

```js
const socket = io(`${API_ORIGIN}/rt`, { auth: { token: accessToken } });
```

**The token is presented at connect, not per message.** The server verifies it once and fixes the connection's principal. There is no field on any client message that contributes to identity — a client cannot declare who it is, and cannot name a tenant.

Two credentials are accepted, told apart by prefix, exactly as on the HTTP surface:

| Credential | Prefix | Resolves to |
| --- | --- | --- |
| Staff access token (JWT) | none | staff principal, `tenantId` and `role` from signed claims |
| Contact access token (JWT) | none | Contact principal (`Portal` sign-in) |
| Widget session token | `nvw_` | widget principal, `tenantId` from a signed claim, Contact from the session row |

Service tokens (`nvk_live_`) are **refused**. Machines do not hold sockets.

**A failed handshake is refused before the connection exists.** The client receives `connect_error` with message `unauthenticated` and never enters a connected state:

```js
socket.on('connect_error', (err) => {
  if (err.message === 'unauthenticated') { /* re-authenticate, do not retry the same token */ }
});
```

Every failure is that one answer — no token, a malformed one, an expired one, a revoked widget session, a service token. Do not branch on the reason; there is none given.

### Authority is a snapshot

The principal is fixed at connect and never re-evaluated. A role change, or a revoked widget session, takes effect on the client's **next connection**, not its next frame. This is bounded by token lifetime (15 minutes staff, 30 minutes widget) and by the fact that a socket only ever reads. Clients that reconnect on token refresh get the new authority for free.

---

## 2. Rooms

Every room name carries its tenant, so tenant isolation is a string comparison and cross-tenant subscription is impossible by construction rather than by review.

| Room | Who may join | What arrives |
| --- | --- | --- |
| `t:<tenantId>:agents` | staff only | `ticket.created`, `ticket.updated`, `ticket.assigned` |
| `t:<tenantId>:ticket:<ticketId>` | staff of the tenant; the Contact who requested that Ticket | `ticket.updated`, `message.created` |
| `t:<tenantId>:ticket:<ticketId>:internal` | staff only | `note.created` |

`<tenantId>` and `<ticketId>` are UUIDs. A name that does not match this grammar exactly is refused — including a `:ticket:<id>` name with any suffix other than `:internal`.

### The `canJoin` rules

1. **Tenant gate, first and for everyone.** The room's tenant must equal the principal's. A staff member of one tenant asking for another's internal room is refused for the tenant, not for the room — so the answer reveals nothing about whether that Ticket exists.
2. **Staff** may join every room in their own tenant, including any Ticket's. Triage means looking at work that is not yours. `agent` and `admin` see the same rooms; the distinction between those roles is about what they may change, and a socket changes nothing.
3. **Customers** (widget visitor or signed-in Contact) may join **only** `t:<their tenant>:ticket:<id>` and **only** for a Ticket they requested. The `:agents` and `:internal` rooms are refused outright.

The requester check is resolved by reading the Ticket under the principal's own database context, so row-level security answers it. The socket holds no second copy of the ownership rule.

---

## 3. Client messages

### `subscribe`

```ts
socket.emit('subscribe', { room: string, afterSeq?: number }, (ack) => { … });
```

`afterSeq` is the highest `seq` this client has already seen **in that room**. Omit it, or send `0`, for a fresh subscribe.

Acknowledgement:

```ts
| { ok: true,  room: string, replayed: number, gap: boolean }
| { ok: false, error: 'forbidden' | 'malformed_request' }
```

- `forbidden` — the gate refused. A room in another tenant, a room this principal's axis cannot enter, a Ticket they did not request, and a name that is not a room at all are all this same answer.
- `malformed_request` — the message was not `{ room: string, afterSeq?: non-negative integer }`.
- `replayed` — how many envelopes were emitted to this socket as replay, **before** the ack arrived.
- `gap` — see §6.

The server **joins the room first, then replays**. That ordering can deliver an event both live and in the replay; it can never drop one. Dedupe on `(room, seq)`.

### `unsubscribe`

```ts
socket.emit('unsubscribe', { room: string }, (ack) => { … });   // → { ok: true, room }
```

Always acknowledged, including for a room the socket was never in. Leaving is not a capability.

---

## 4. The envelope

Every event, without exception:

```ts
interface RealtimeEnvelope {
  event: string;   // one of §5
  room: string;    // the room this copy was delivered into
  seq: number;     // monotonic within `room`, from 1
  ts: string;      // ISO-8601 instant, server clock
  data: object;    // per §5
}
```

The envelope is delivered under the event's own name as the message name:

```js
socket.on('message.created', (envelope) => { … });
```

`room` is carried inside the envelope even though the transport already routed by it, because `seq` is meaningless without it.

`ts` is for display and for coarse cross-room ordering. **It is not the ordering authority** — `seq` is.

---

## 5. Events

### `ticket.created`, `ticket.updated`, `ticket.assigned`

`data` is a full **Ticket snapshot**, identical for all three:

```ts
{
  id: string;
  subject: string;
  state: 'open' | 'pending' | 'resolved' | 'closed';
  priority: 'low' | 'normal' | 'high' | 'urgent';
  source: 'portal' | 'widget' | 'slack';
  contactId: string;
  assigneeId: string | null;
  spawnedFromTicketId: string | null;
  rootTicketId: string | null;
  createdAt: string;   // ISO-8601
  updatedAt: string;   // ISO-8601
}
```

A snapshot rather than a diff: a client that missed the previous state cannot apply a diff, and one that has it can compute one. The **event name** is what says which fact changed.

| Event | Rooms | Meaning |
| --- | --- | --- |
| `ticket.created` | `:agents` | A Ticket entered the queue — opened directly, or spawned by a reply to a closed one. |
| `ticket.updated` | `:agents` **and** `:ticket:<id>` | State, priority, or a reopen. Two copies, **separately numbered** — dedupe each stream on its own `(room, seq)`. |
| `ticket.assigned` | `:agents` | The assignee changed, including to `null`. Dashboard-only: who is working a Ticket is queue information, not the customer's business. |

There is no `ticket.state.changed`. One event per column would be a catalog that grows with the schema.

### `message.created`, `note.created`

`data` is a **thread entry**, the same shape for both:

```ts
{
  id: string;
  ticketId: string;
  body: string;
  authorKind: 'user' | 'contact' | 'service' | 'system';
  authorId: string | null;
  createdAt: string;   // ISO-8601
}
```

| Event | Room | Audience |
| --- | --- | --- |
| `message.created` | `:ticket:<id>` | everyone in the room |
| `note.created` | `:ticket:<id>:internal` | **staff only** |

The payloads being identical is safe because nothing decides which is which from a field: a Note is a Note because it was emitted under `note.created` into the `:internal` room.

### `ticket.sla.breached`

`data` is a **breach**, not a Ticket snapshot:

```ts
{
  ticketId: string;
  timer: 'first_response' | 'resolution';
  breachedAt: string;   // ISO-8601, the latch value
}
```

| Event | Room | Audience |
| --- | --- | --- |
| `ticket.sla.breached` | `:agents` | **staff only** |

Deliberately not a snapshot: the other ticket events announce that a Ticket changed, and this one announces that *nothing* changed for too long — the Ticket's columns read exactly as they did a second ago, so a console handed a snapshot would diff away the only fact being reported.

`breachedAt` is the **latch value**, not the emission time. The two differ by however long the sweep took to notice, and a dashboard sorting by urgency wants the former; it is also what keeps the event truthful on replay.

Emitted **once per timer for the life of the Ticket**. Fire-once rests on a set-once `IS NULL` latch column in Postgres, so it holds across repeated sweeps, a restart, and two schedulers running at once. Escalation is **notify, don't mutate** — no `ticket.updated` accompanies it, because the breach changes neither priority nor assignee.

### `ticket.integration.failed`

`data` names the reply that did not arrive, and — like a breach — is deliberately not a Ticket snapshot:

```ts
{
  ticketId: string;
  messageId: string;
  source: string;   // the adapter that gave up; `slack` today
  target: string;   // where it was trying to reach, as that adapter spells one
  error: string;    // the far end's own words
}
```

| Event | Room | Audience |
| --- | --- | --- |
| `ticket.integration.failed` | `:agents` | **staff only** |

Emitted when delivery of a customer-visible Message to the channel a Ticket arrived on is **permanently abandoned** — the retries are exhausted, or the far end reported something no amount of waiting will fix.

Not a snapshot, for the same reason a breach is not: nothing about the Ticket changed. **Notify, don't mutate** — the Ticket is not reopened, escalated, or flagged, because an integration outage must not be able to rewrite a tenant's queue. No `ticket.updated` accompanies it.

Staff-only, and this one plainly: the person who needs it is the agent who typed the reply and believes it was delivered. The Message is sitting in the thread, the Ticket looks answered, and the customer is still waiting. Telling the customer instead would be worse than the silence — they can do nothing with it.

`error` is carried rather than left to the log because the remedies differ and an agent can act on some of them: a channel not found means the bot was removed, a rate limit means try later, an auth failure means an admin has work to do. The durable record is the `dead` delivery row; this event is the tap on the shoulder.

### Reserved

Typing and presence indicators are **out of scope** and deliberately absent; the envelope is forward-compatible, so adding them later is additive.

---

## 6. Delivery semantics

### Ordering

`seq` is **monotonic per room, starting at 1**. There is no global sequence, and none is needed: nobody has to know whether a Note on one Ticket preceded a Message on another.

`seq` is **monotonic but not contiguous**. A customer's stream has holes where a staff-only event occupied a number — 1, 3, 4 is normal and is not a lost event. Do not treat a missing number as a gap; use the `gap` flag.

### At-least-once

An envelope may arrive more than once — most commonly around the join/replay boundary on a reconnect. **Dedupe on `(room, seq)`.** Nothing is delivered out of order within a room.

Delivery is **not transactional with the write**. Events are emitted after the producing transaction commits, so an event never describes a state that rolled back; the converse is that a committed change whose delivery failed is simply not delivered, and is recovered by replay or by a REST read.

### Reconnect and replay

Reconnect, then `subscribe` with `afterSeq` = the highest `seq` you hold for that room. The server replays everything after it, audience-filtered — **a widget never replays a Note it was denied live**, because "the leak arrives ninety seconds late" is not a smaller leak.

The buffer is **bounded** (200 envelopes per room, 2000 rooms). Beyond that window the server cannot answer honestly, and says so:

> **`gap: true` means: discard your cursor and local state for this room, refetch it over REST, and treat what follows as a fresh start.**

A short replay with `gap: false` means you are genuinely caught up. A `gap: true` is also what you get for a room the server has forgotten entirely — which is the same instruction, so no special case is needed.

`afterSeq: 0` never reports a gap: a client with no history cannot have missed anything.

### Single process, today

Sequencing and the replay buffer are in-memory and per-process. A multi-process deployment needs a shared backing store (`INCR` plus a capped stream per room); the client contract above does not change when that lands.

---

## 7. Client checklist

- [ ] Connect with `auth: { token }`; reconnect on token refresh.
- [ ] Handle `connect_error` with message `unauthenticated` by re-authenticating, not by retrying the same token.
- [ ] Keep the highest `seq` **per room**, not globally.
- [ ] Dedupe on `(room, seq)`; expect duplicates and non-contiguous numbers.
- [ ] Send `afterSeq` on every re-`subscribe`.
- [ ] On `gap: true`, drop local state for that room and refetch over REST.
- [ ] Never infer authority from what did or did not arrive — the REST surface is the authority on what a principal may see.
