import { StaffPrincipal } from '../auth/request-principal';
import { UserRole } from '../generated/prisma/client';
import {
  authenticatedKey,
  slackGlobalKey,
  slackIpKey,
} from './rate-limit-keys';

const staff = (tenantId: string, userId: string): StaffPrincipal => ({
  kind: 'user',
  tenantId,
  userId,
  role: UserRole.agent,
});

/**
 * What each ceiling counts against.
 *
 * The keys are the whole of the isolation story: there is no filter anywhere
 * that keeps one tenant out of another's budget, because the budgets are
 * different keys.
 */
describe('the authenticated key', () => {
  const bucket = 60;

  /**
   * The acceptance criterion stated as an assertion. The tenant prefix exists
   * for isolation and nothing else — nobody has a per-tenant ceiling — so the
   * only thing it has to do is keep two tenants' counters apart.
   */
  it('separates the same principal id across two tenants', () => {
    expect(authenticatedKey(staff('t1', 'u1'), bucket)).not.toBe(
      authenticatedKey(staff('t2', 'u1'), bucket),
    );
  });

  it('separates two principals within one tenant', () => {
    expect(authenticatedKey(staff('t1', 'u1'), bucket)).not.toBe(
      authenticatedKey(staff('t1', 'u2'), bucket),
    );
  });

  /**
   * A Contact and a User whose ids collide are two callers, because the
   * reference is prefixed by kind. Asserted here rather than left to
   * `principalRef`'s own tests, since this is the key that would leak.
   */
  it('separates principal kinds sharing an id', () => {
    expect(authenticatedKey(staff('t1', 'x'), bucket)).not.toBe(
      authenticatedKey(
        { kind: 'contact', tenantId: 't1', contactId: 'x' },
        bucket,
      ),
    );
  });

  it('holds one caller to one key within a window', () => {
    expect(authenticatedKey(staff('t1', 'u1'), bucket)).toBe(
      authenticatedKey(staff('t1', 'u1'), bucket),
    );
  });

  it('starts a fresh counter in the next window', () => {
    expect(authenticatedKey(staff('t1', 'u1'), 60)).not.toBe(
      authenticatedKey(staff('t1', 'u1'), 120),
    );
  });
});

describe('the Slack keys', () => {
  it('separates two addresses', () => {
    expect(slackIpKey('203.0.113.7', 60)).not.toBe(slackIpKey('1.2.3.4', 60));
  });

  /**
   * The backstop is one counter for the whole route, so a flood spread across
   * many addresses still meets a ceiling. It therefore takes no address at all
   * — and taking one would quietly turn it into a second per-IP limit.
   */
  it('gives the global backstop one counter per window', () => {
    expect(slackGlobalKey(60)).toBe(slackGlobalKey(60));
    expect(slackGlobalKey(60)).not.toBe(slackGlobalKey(120));
  });

  /**
   * The public keys carry no tenant, and that is the point rather than an
   * omission: this limiter runs before the signature is verified, so no tenant
   * is known — and the only candidate would be the unverified body's own claim
   * about which workspace it came from, which is exactly the input that must
   * not be trusted.
   */
  it('shares no namespace with the authenticated ceiling', () => {
    const keys = [
      authenticatedKey(staff('t1', 'u1'), 60),
      slackIpKey('203.0.113.7', 60),
      slackGlobalKey(60),
    ];

    expect(new Set(keys).size).toBe(3);
  });
});
