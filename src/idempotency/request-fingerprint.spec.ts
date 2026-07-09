import { requestFingerprint } from './request-fingerprint';

/**
 * The fingerprint decides whether a reused key is a replay or a 422, so its
 * whole job is to answer "is this the same request?" the way a caller would.
 *
 * Two failure directions, and they are not symmetric. Too *sensitive* — a hash
 * that changes when a client reserialises the same object with its keys in a
 * different order — turns a legitimate retry into a 422, which is annoying but
 * loud. Too *loose* turns a genuinely different request into a replay of an
 * earlier response, which reports success for an operation that never ran. The
 * tests below are weighted accordingly: the ordering cases exist so retries
 * work, and the distinguishing cases exist so that never happens.
 */
describe('requestFingerprint', () => {
  it('is stable for the same body', () => {
    const body = { subject: 'Printer on fire', contactId: 'c-1' };

    expect(requestFingerprint(body)).toBe(requestFingerprint({ ...body }));
  });

  it('ignores the order keys happen to be serialised in', () => {
    // The case that matters most in practice: a client retrying does not
    // guarantee its JSON serialiser emits the same key order twice, and a
    // fingerprint that noticed would reject exactly the retry it exists to
    // allow.
    expect(requestFingerprint({ a: 1, b: 2 })).toBe(
      requestFingerprint({ b: 2, a: 1 }),
    );
  });

  it('ignores key order at every depth, not just the top level', () => {
    expect(requestFingerprint({ outer: { a: 1, b: [{ x: 1, y: 2 }] } })).toBe(
      requestFingerprint({ outer: { b: [{ y: 2, x: 1 }], a: 1 } }),
    );
  });

  it('distinguishes a changed value', () => {
    expect(requestFingerprint({ priority: 'high' })).not.toBe(
      requestFingerprint({ priority: 'urgent' }),
    );
  });

  it('distinguishes an added field', () => {
    expect(requestFingerprint({ a: 1 })).not.toBe(
      requestFingerprint({ a: 1, b: 2 }),
    );
  });

  it('respects array order, which is data rather than serialisation', () => {
    expect(requestFingerprint({ tags: ['a', 'b'] })).not.toBe(
      requestFingerprint({ tags: ['b', 'a'] }),
    );
  });

  it('distinguishes an absent field from an explicitly null one', () => {
    // `{"assigneeId": null}` means "unassign" on this API and `{}` means "leave
    // it alone". Collapsing the two would let one be replayed as the other.
    expect(requestFingerprint({ assigneeId: null })).not.toBe(
      requestFingerprint({}),
    );
  });

  it('distinguishes a number from its string form', () => {
    expect(requestFingerprint({ n: 1 })).not.toBe(
      requestFingerprint({ n: '1' }),
    );
  });

  it('handles a body-less request without throwing, and stably', () => {
    // A POST with no body is a real shape — a sub-resource action addressed
    // entirely by its URL — and it is entitled to a key like any other.
    expect(requestFingerprint(undefined)).toBe(requestFingerprint(undefined));
  });

  it('distinguishes no body from an empty object', () => {
    expect(requestFingerprint(undefined)).not.toBe(requestFingerprint({}));
  });

  it('produces a hex digest short enough to index and long enough not to collide', () => {
    expect(requestFingerprint({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});
