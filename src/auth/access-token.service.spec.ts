import { principalFromClaims } from './access-token.service';

/**
 * The claim check, without a key.
 *
 * A valid signature proves this server issued the token — not that it issued
 * it with the claims this code expects. A token minted before a claim existed,
 * or by a version that spelled it differently, verifies perfectly and carries
 * nothing usable, and `tenantId` is far too load-bearing to read on trust:
 * an absent one would arm `undefined` as a tenant.
 */
describe('principalFromClaims', () => {
  const valid = {
    sub: '019f74e2-3cea-72cd-ba57-28ff476a61b9',
    tenantId: '019f74e2-3e58-733c-968b-c0e346a21a71',
    role: 'admin',
  };

  it('reduces a well-formed claim set to a principal', () => {
    expect(principalFromClaims(valid)).toEqual({
      kind: 'user',
      userId: valid.sub,
      tenantId: valid.tenantId,
      role: 'admin',
    });
  });

  it.each([
    ['no subject', { ...valid, sub: undefined }],
    ['an empty subject', { ...valid, sub: '' }],
    ['no tenant', { ...valid, tenantId: undefined }],
    ['an empty tenant', { ...valid, tenantId: '' }],
    ['no role', { ...valid, role: undefined }],
    ['a role outside the enum', { ...valid, role: 'superuser' }],
    ['a non-string subject', { ...valid, sub: 42 }],
  ])('refuses claims with %s', (_case, claims) => {
    expect(principalFromClaims(claims)).toBeNull();
  });

  it.each([
    ['null', null],
    ['a string', 'not-claims'],
    ['a number', 7],
  ])('refuses %s in place of a claim object', (_case, claims) => {
    expect(principalFromClaims(claims)).toBeNull();
  });
});
