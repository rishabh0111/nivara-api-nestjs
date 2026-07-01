import { principalFromClaims } from './access-token.service';

/**
 * The claim check, without a key.
 *
 * A valid signature proves this server issued the token — not that it issued
 * it with the claims this code expects. A token minted before a claim existed,
 * or by a version that spelled it differently, verifies perfectly and carries
 * nothing usable, and `tenantId` is far too load-bearing to read on trust:
 * an absent one would arm `undefined` as a tenant.
 *
 * With two principal kinds signed by one secret, this function carries a second
 * job: it is the only thing standing between a portal token and a staff
 * principal. Both tokens verify — same key, same issuer, same audience — so the
 * *shape* check here is the whole of the separation, which is why `kind` is
 * required explicitly rather than inferred from which other claims happen to be
 * present.
 */
describe('principalFromClaims', () => {
  const staff = {
    kind: 'user',
    sub: '019f74e2-3cea-72cd-ba57-28ff476a61b9',
    tenantId: '019f74e2-3e58-733c-968b-c0e346a21a71',
    role: 'admin',
  };

  const contact = {
    kind: 'contact',
    sub: '019f74e2-4a01-7b2c-9d3e-11ff476a61c4',
    tenantId: '019f74e2-3e58-733c-968b-c0e346a21a71',
  };

  describe('a staff token', () => {
    it('reduces a well-formed claim set to a staff principal', () => {
      expect(principalFromClaims(staff)).toEqual({
        kind: 'user',
        userId: staff.sub,
        tenantId: staff.tenantId,
        role: 'admin',
      });
    });

    it.each([
      ['no subject', { ...staff, sub: undefined }],
      ['an empty subject', { ...staff, sub: '' }],
      ['no tenant', { ...staff, tenantId: undefined }],
      ['an empty tenant', { ...staff, tenantId: '' }],
      ['no role', { ...staff, role: undefined }],
      ['a role outside the enum', { ...staff, role: 'superuser' }],
      ['a non-string subject', { ...staff, sub: 42 }],
    ])('refuses claims with %s', (_case, claims) => {
      expect(principalFromClaims(claims)).toBeNull();
    });
  });

  describe('a portal token', () => {
    it('reduces a well-formed claim set to a contact principal', () => {
      expect(principalFromClaims(contact)).toEqual({
        kind: 'contact',
        contactId: contact.sub,
        tenantId: contact.tenantId,
      });
    });

    it.each([
      ['no subject', { ...contact, sub: undefined }],
      ['an empty subject', { ...contact, sub: '' }],
      ['no tenant', { ...contact, tenantId: undefined }],
      ['an empty tenant', { ...contact, tenantId: '' }],
    ])('refuses claims with %s', (_case, claims) => {
      expect(principalFromClaims(claims)).toBeNull();
    });

    /**
     * The escalation this function exists to refuse.
     *
     * A portal token is signed with the same secret as a staff token, so a
     * Contact holding one holds a validly-signed credential. If `role` were read
     * whenever it appeared, a token carrying both `kind: 'contact'` and a role
     * claim would be a question about evaluation order — and the wrong answer
     * is a customer with admin authority. The discriminant decides alone, and
     * the role is not read on this branch at all.
     */
    it('ignores a role claim smuggled onto a contact token', () => {
      expect(principalFromClaims({ ...contact, role: 'admin' })).toEqual({
        kind: 'contact',
        contactId: contact.sub,
        tenantId: contact.tenantId,
      });
    });
  });

  /**
   * `kind` is required rather than defaulted, and these are why.
   *
   * Defaulting an absent `kind` to `user` would mean any token that lost the
   * claim — an old one, a hand-rolled one, one from a port that spelled it
   * differently — arriving as staff. Defaulting it to `contact` fails in the
   * safer direction but still lets shape decide identity. Refusing outright is
   * the only answer that never guesses, and the cost is bounded: tokens live
   * fifteen minutes, so a deploy that changed this is fully rolled through
   * before the next coffee.
   */
  describe('the discriminant itself', () => {
    it.each([
      [
        'no kind at all',
        { sub: staff.sub, tenantId: staff.tenantId, role: 'admin' },
      ],
      ['an empty kind', { ...staff, kind: '' }],
      ['an unknown kind', { ...staff, kind: 'service' }],
      ['a non-string kind', { ...staff, kind: 7 }],
    ])('refuses a token with %s', (_case, claims) => {
      expect(principalFromClaims(claims)).toBeNull();
    });
  });

  it.each([
    ['null', null],
    ['a string', 'not-claims'],
    ['a number', 7],
  ])('refuses %s in place of a claim object', (_case, claims) => {
    expect(principalFromClaims(claims)).toBeNull();
  });
});
