import { Injectable } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { TenantClient } from '../tenancy/tenancy.service';
import {
  RefreshVerdict,
  classifyPresentedToken,
  familyExpiryFor,
  slidingExpiryFor,
} from './refresh-token-lifecycle';

/**
 * 32 bytes of CSPRNG output. The token carries no structure and no claims —
 * it is a lookup key and nothing else, which is what makes it revocable in a
 * way a self-contained JWT is not.
 */
const TOKEN_BYTES = 32;

/**
 * `sha256`, not argon2, and deliberately so.
 *
 * Password hashing is slow on purpose because a password is low-entropy and
 * guessable. A 256-bit random token is neither, so there is nothing for a slow
 * hash to defend against — and this runs on every silent refresh, where a
 * deliberate hundred milliseconds would be a cost paid on every page load. The
 * property that matters is only that the stored form is not itself usable,
 * which sha256 gives.
 */
const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');

/** The one raw copy of a newly minted token. It exists nowhere else. */
export interface IssuedRefreshToken {
  token: string;
}

/**
 * A verdict, plus the row it was reached about.
 *
 * `unknown` is its own arm rather than a null, because a token that matches no
 * row is not the absence of an answer — it is the answer, and one the caller
 * must handle exactly as it handles a refusal.
 */
export type PresentedTokenOutcome =
  | { outcome: 'unknown' }
  | { verdict: RefreshVerdict; userId: string; familyId: string };

/**
 * The refresh-token ledger.
 *
 * Every method takes a `TenantClient` rather than reaching for the database
 * itself: the caller already holds an armed transaction, and rotation must be
 * atomic with the read that authorized it. Two concurrent refreshes on one
 * token would otherwise both see a live row and both rotate it, which is
 * exactly the state replay detection exists to notice.
 */
@Injectable()
export class RefreshTokenService {
  /**
   * Begins a family. Called once per sign-in, and never again for that session
   * — every later token is a rotation of this one.
   */
  async issue(
    tx: TenantClient,
    input: { tenantId: string; userId: string; now: Date },
  ): Promise<IssuedRefreshToken> {
    return this.write(tx, {
      ...input,
      familyId: randomUUID(),
      familyExpiresAt: familyExpiryFor(input.now),
    });
  }

  /**
   * Resolves a presented token to a verdict.
   *
   * Looks up by hash alone. The row's `userId` comes back from storage rather
   * than from anything the caller said, so a token cannot be presented on
   * behalf of a different User than the one it was issued to.
   */
  async classify(
    tx: TenantClient,
    token: string,
    now: Date,
  ): Promise<PresentedTokenOutcome> {
    const row = await tx.refreshToken.findFirst({
      where: { tokenHash: hashToken(token) },
    });

    if (!row) return { outcome: 'unknown' };

    return {
      verdict: classifyPresentedToken(row, now),
      userId: row.userId,
      familyId: row.familyId,
    };
  }

  /**
   * Spends a token and issues its successor, inside the caller's transaction.
   *
   * The update is conditional on `rotatedAt` still being null, so if two
   * requests race on the same token exactly one of them rotates it. The loser
   * updates zero rows and is refused — and on its next attempt reads a rotated
   * row, which is the replay path. A race is indistinguishable from theft from
   * here, and treating it as theft is the safe direction to be wrong in.
   */
  async rotate(
    tx: TenantClient,
    input: { token: string; now: Date },
  ): Promise<IssuedRefreshToken | null> {
    const hash = hashToken(input.token);

    const spent = await tx.refreshToken.updateMany({
      where: { tokenHash: hash, rotatedAt: null },
      data: { rotatedAt: input.now },
    });

    if (spent.count === 0) return null;

    const predecessor = await tx.refreshToken.findFirst({
      where: { tokenHash: hash },
    });

    if (!predecessor) return null;

    // Tenant, user and family all come off the predecessor row rather than
    // from the caller. A successor is by definition the same session as the
    // token it replaces, so there is no argument a caller could pass here that
    // would be anything but a way to get it wrong.
    return this.write(tx, {
      tenantId: predecessor.tenantId,
      userId: predecessor.userId,
      now: input.now,
      familyId: predecessor.familyId,
      // Copied, never recomputed. Recomputing it here is how a sliding window
      // silently becomes an unbounded one.
      familyExpiresAt: predecessor.familyExpiresAt,
    });
  }

  /**
   * Evicts a whole family — on sign-out, and on replay.
   *
   * Family-wide rather than token-wide because after a replay there is no way
   * to tell the thief's copy from the victim's. Revoking both is the point:
   * the legitimate client signs in again, and so does nobody else.
   */
  async revokeFamily(
    tx: TenantClient,
    familyId: string,
    now: Date,
  ): Promise<void> {
    await tx.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: now },
    });
  }

  private async write(
    tx: TenantClient,
    input: {
      tenantId: string;
      userId: string;
      now: Date;
      familyId: string;
      familyExpiresAt: Date;
    },
  ): Promise<IssuedRefreshToken> {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');

    await tx.refreshToken.create({
      data: {
        tenantId: input.tenantId,
        userId: input.userId,
        // The only place the raw token is turned into what is stored. It is
        // never written anywhere in its usable form.
        tokenHash: hashToken(token),
        familyId: input.familyId,
        expiresAt: slidingExpiryFor(input.now),
        familyExpiresAt: input.familyExpiresAt,
      },
    });

    return { token };
  }
}
