import {
  SERVICE_TOKEN_PREFIX,
  hashServiceToken,
  isServiceToken,
  mintServiceToken,
  parseServiceToken,
} from './service-token-format';

const TENANT = '3f1a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8';

describe('minting a service token', () => {
  it('carries the prefix the guard routes on', () => {
    const { raw } = mintServiceToken(TENANT);

    expect(isServiceToken(raw)).toBe(true);
    expect(raw.startsWith(SERVICE_TOKEN_PREFIX)).toBe(true);
  });

  it('never repeats itself', () => {
    const minted = new Set(
      Array.from({ length: 64 }, () => mintServiceToken(TENANT).raw),
    );

    expect(minted.size).toBe(64);
  });

  /**
   * The property the whole "shown once" promise rests on: what is handed to the
   * admin and what is written to the row are different strings, and the second
   * cannot be turned back into the first.
   */
  it('produces a hash that is not the token', () => {
    const { raw, tokenHash } = mintServiceToken(TENANT);

    expect(tokenHash).not.toBe(raw);
    expect(raw).not.toContain(tokenHash);
    expect(tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes the token it returns', () => {
    const { raw, tokenHash } = mintServiceToken(TENANT);

    expect(hashServiceToken(raw)).toBe(tokenHash);
  });

  /**
   * The hash covers the whole presented value, tenant segment included. A token
   * re-presented with another tenant's id spliced in front of the same secret
   * therefore hashes to nothing on file — so the routing segment cannot be
   * edited into a claim about which tenant the secret belongs to.
   */
  it('hashes the tenant segment along with the secret', () => {
    const { raw, tokenHash } = mintServiceToken(TENANT);
    const other = '9e8d7c6b-5a49-4837-9261-05f4e3d2c1b0';
    const relabelled = raw.replace(TENANT, other);

    expect(relabelled).not.toBe(raw);
    expect(hashServiceToken(relabelled)).not.toBe(tokenHash);
  });
});

describe('recognising a service token', () => {
  it('rejects the other credential types', () => {
    expect(isServiceToken('nvw_eyJhbGciOiJIUzI1NiJ9.x.y')).toBe(false);
    expect(isServiceToken('eyJhbGciOiJIUzI1NiJ9.x.y')).toBe(false);
    expect(isServiceToken('')).toBe(false);
  });
});

describe('parsing a presented service token', () => {
  it('recovers the tenant the token was minted for', () => {
    const { raw } = mintServiceToken(TENANT);

    expect(parseServiceToken(raw)).toEqual({
      tenantId: TENANT,
      tokenHash: hashServiceToken(raw),
    });
  });

  /**
   * `null` for every malformed shape alike. The tenant segment is a routing
   * hint, so the only question worth answering here is whether there is
   * somewhere to look — and the lookup, not this function, decides authority.
   */
  it.each([
    ['no prefix', `${TENANT}.secret`],
    ['no separator', `${SERVICE_TOKEN_PREFIX}${TENANT}secret`],
    ['no secret', `${SERVICE_TOKEN_PREFIX}${TENANT}.`],
    ['no tenant', `${SERVICE_TOKEN_PREFIX}.secret`],
    ['a tenant that is not a uuid', `${SERVICE_TOKEN_PREFIX}meridian.secret`],
    ['nothing at all', SERVICE_TOKEN_PREFIX],
  ])('refuses %s', (_case, value) => {
    expect(parseServiceToken(value)).toBeNull();
  });

  /**
   * A secret containing the separator would otherwise be truncated at the first
   * dot and hash to something that matches nothing — a token that mints fine
   * and never authenticates. The alphabet rules it out; this pins the rule.
   */
  it('mints secrets that contain no separator', () => {
    for (let attempt = 0; attempt < 64; attempt += 1) {
      const { raw } = mintServiceToken(TENANT);

      expect(raw.slice(SERVICE_TOKEN_PREFIX.length).split('.')).toHaveLength(2);
    }
  });
});
