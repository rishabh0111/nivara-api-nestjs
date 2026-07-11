import { IncomingMessage } from 'http';

/** The bucket a request with no determinable address falls into. */
const UNKNOWN = 'unknown';

/**
 * How many appending proxies sit in front of this process.
 *
 * One, which is what every deployment target for this service currently looks
 * like: a single platform router (Fly, Render, Heroku, an ALB) that appends the
 * address it saw and forwards on.
 *
 * **This number must match the deployment, and getting it wrong is quiet.** Set
 * too low, the limiter reads an address the client controls and can be bypassed
 * by prepending a header. Set too high — or left at one behind a second hop,
 * say a load balancer in front of an ingress — every request instead resolves
 * to the *internal* address of that last hop, which is the same string for all
 * traffic. The per-IP ceiling then silently becomes a second global one at
 * 60/min and starts refusing legitimate Slack ingestion.
 *
 * A constant rather than a fourth environment variable, because it is a
 * property of the deployment topology rather than a limit to tune, and it
 * should change in a reviewed commit alongside the infrastructure change that
 * caused it. If a target ever needs a different depth, this is the one line to
 * move into configuration.
 */
const PLATFORM_PROXY_HOPS = 1;

/**
 * The address to limit a pre-trust request on.
 *
 * Read straight off the request rather than through Express's `req.ip`, and
 * that is deliberate. `req.ip` answers correctly only once `trust proxy` has
 * been set to match the deployment, which is a setting in `main.ts` that no
 * test exercises and that silently degrades to "the first entry a client sent"
 * when it is wrong. The one place in this system that keys on an address is
 * also the one place where getting it wrong means the limiter can be bypassed
 * with a header, so it does its own reading and states the rule in a test.
 *
 * The rule is: count `PLATFORM_PROXY_HOPS` entries back from the **end** of
 * `X-Forwarded-For`. Every proxy in a chain appends the peer it received the
 * request from, so the entries at the end are the ones our own infrastructure
 * wrote and everything before them is whatever the caller chose to send. The
 * intuitive read — the first entry, "the original client" — is the forgeable
 * one, and keying on it would let a single caller mint a fresh bucket per
 * request.
 *
 * With the one hop this deploys behind, that is simply the last entry. The
 * indexing is written in terms of the constant anyway, because the failure it
 * guards against is invisible: see `PLATFORM_PROXY_HOPS`.
 *
 * The cost is that a genuine client behind its own proxy is limited alongside
 * that proxy's other users. That is the right trade here: this ceiling is the
 * pre-trust backstop on one unauthenticated route, and over-sharing a bucket
 * costs a real caller a retry, whereas trusting the header costs the ceiling
 * entirely.
 */
export const clientIp = (request: IncomingMessage): string => {
  const forwarded = request.headers['x-forwarded-for'];

  const chain = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded)
    ?.split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

  // A chain shorter than the expected hop count means the header did not come
  // through the proxies it should have. Falling back to the socket peer is the
  // conservative reading: it is the one address in the request that cannot be
  // forged, even if it is the proxy's own.
  const forwardedHop =
    chain && chain.length >= PLATFORM_PROXY_HOPS
      ? chain[chain.length - PLATFORM_PROXY_HOPS]
      : undefined;

  const address = forwardedHop ?? request.socket?.remoteAddress;

  return address ? normalise(address) : UNKNOWN;
};

/**
 * A socket peer arrives IPv4-mapped (`::ffff:203.0.113.7`) where the same
 * address in a proxy header does not. Unnormalised, one client would hold two
 * buckets depending on how its request reached the process, and so get twice
 * the budget it was allotted.
 */
const normalise = (address: string): string =>
  address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
