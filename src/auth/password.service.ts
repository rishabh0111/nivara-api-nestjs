import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

/**
 * Argon2id, with the library's defaults for memory, iterations and
 * parallelism. The parameters are encoded in the hash string itself, so raising
 * them later is a rehash-on-next-login change rather than a migration.
 */
const OPTIONS: argon2.Options = { type: argon2.argon2id };

@Injectable()
export class PasswordService {
  async hash(password: string): Promise<string> {
    return argon2.hash(password, OPTIONS);
  }

  /**
   * Verifies a password against a hash that may not exist.
   *
   * Accepting `null` is what lets the login path treat "no such user" and
   * "wrong password" identically: an invited User with no credential yet, and
   * an email belonging to nobody, both land here and both cost roughly one
   * hash computation. Returning early on a missing hash would make the two
   * cases distinguishable by response time, which is a tenant-membership
   * oracle for anyone willing to measure.
   */
  async verify(hash: string | null, password: string): Promise<boolean> {
    if (hash === null) {
      await this.burnTime(password);
      return false;
    }

    try {
      return await argon2.verify(hash, password, OPTIONS);
    } catch {
      // A malformed or foreign-format hash. Not a credential, not a crash.
      return false;
    }
  }

  /**
   * Spends about as long as a real verification would, so a login against an
   * unknown email is not visibly faster than one against a known one.
   */
  private async burnTime(password: string): Promise<void> {
    await argon2.hash(password, OPTIONS);
  }
}
