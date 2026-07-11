import { clientIp } from './client-ip';

const request = (forwardedFor?: string | string[], socketAddress?: string) =>
  ({
    headers:
      forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
    socket: { remoteAddress: socketAddress },
  }) as Parameters<typeof clientIp>[0];

/**
 * Transport-level identity, established before anything in the request is
 * trusted.
 *
 * This runs ahead of signature verification on the public Slack route, so every
 * input it reads is attacker-controlled except one — and the tests below are
 * mostly about which one that is.
 */
describe('the client address', () => {
  it('falls back to the socket peer when no proxy header is present', () => {
    expect(clientIp(request(undefined, '203.0.113.7'))).toBe('203.0.113.7');
  });

  /**
   * The single decision this file exists to make. Each proxy *appends* the peer
   * it received the request from, so the last entry is the address the platform
   * proxy actually observed and the earlier ones are whatever the client chose
   * to send. Reading the first entry — the usual reflex, because it is
   * nominally "the original client" — would let any caller mint a fresh
   * identity per request by varying a header, which is a rate limiter that
   * limits nothing.
   */
  it('takes the last forwarded entry, not the client-supplied first', () => {
    expect(clientIp(request('198.51.100.1, 198.51.100.2, 203.0.113.7'))).toBe(
      '203.0.113.7',
    );
  });

  it('cannot be steered by a spoofed entry the client prepends', () => {
    const spoofed = clientIp(request('1.2.3.4, 203.0.113.7'));
    const plain = clientIp(request('203.0.113.7'));

    expect(spoofed).toBe(plain);
  });

  /**
   * Express hands back a repeated header as an array. Joining and taking the
   * last entry keeps the rule identical — the last hop is the last hop however
   * the header was split across lines.
   */
  it('reads a repeated header as one chain', () => {
    expect(clientIp(request(['1.2.3.4', '203.0.113.7']))).toBe('203.0.113.7');
  });

  /**
   * A socket peer arrives IPv4-mapped while the same address in a proxy header
   * does not. Left alone, one client would occupy two buckets depending on how
   * the request reached us, and so get twice its budget.
   */
  it('normalises an IPv4-mapped IPv6 address', () => {
    expect(clientIp(request(undefined, '::ffff:203.0.113.7'))).toBe(
      '203.0.113.7',
    );
  });

  it('ignores blank entries in the chain', () => {
    expect(clientIp(request('203.0.113.7, '))).toBe('203.0.113.7');
  });

  /**
   * The hop count is what stops the per-IP ceiling silently collapsing into a
   * second global one.
   *
   * Behind more appending proxies than expected, the entry read would be an
   * internal address identical for all traffic, and every caller would land in
   * one bucket — refusing legitimate Slack ingestion at 60/min while looking
   * like it was working. These two cases pin which entry is read, so a topology
   * change that invalidates `PLATFORM_PROXY_HOPS` breaks a test rather than
   * production.
   */
  it('reads the entry one hop back, for the single-proxy topology it deploys behind', () => {
    expect(clientIp(request('client, 203.0.113.7'))).toBe('203.0.113.7');
    expect(clientIp(request('203.0.113.7'))).toBe('203.0.113.7');
  });

  /**
   * A chain shorter than the expected hop count means the request did not
   * arrive through the proxies it should have. The socket peer is the
   * conservative answer: the one address in the request nobody can forge.
   */
  it('falls back to the socket peer when the chain is empty', () => {
    expect(clientIp(request('  ', '203.0.113.7'))).toBe('203.0.113.7');
  });

  /**
   * Named rather than allowed through. A request with no determinable address
   * is unusual enough that it should share one bucket and be visible there —
   * whereas returning null would mean skipping the per-IP ceiling entirely, so
   * stripping the header would become the way around it.
   */
  it('names an unknown address rather than skipping the limit', () => {
    expect(clientIp(request(undefined, undefined))).toBe('unknown');
    expect(clientIp(request('  '))).toBe('unknown');
  });
});
