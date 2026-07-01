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
 * Whose session this is.
 *
 * A discriminated pair rather than two nullable ids, so a caller cannot read the
 * wrong one: refreshing a portal session has to `switch` on `kind` to get at an
 * id at all, and there is no shape in which both are readable at once. The
 * database says the same thing with a check constraint; this is that constraint
 * expressed in the type system, on the way back out.
 */
export type SessionSubject =
  { kind: 'user'; userId: string } | { kind: 'contact'; contactId: string };

/**
 * A verdict, plus the row it was reached about.
 *
 * `unknown` is its own arm rather than a null, because a token that matches no
 * row is not the absence of an answer — it is the answer, and one the caller
 * must handle exactly as it handles a refusal.
 */
export type PresentedTokenOutcome =
  | { outcome: 'unknown' }
  | { verdict: RefreshVerdict; subject: SessionSubject; familyId: string };

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
   *
   * Takes a `SessionSubject` rather than a `userId`, which is what makes one
   * ledger serve both axes. A portal session and a staff session differ in this
   * argument and in nothing else: same rotation, same replay detection, same
   * windows.
   */
  async issue(
    tx: TenantClient,
    input: { tenantId: string; subject: SessionSubject; now: Date },
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
   * Looks up by hash alone. The row's subject comes back from storage rather
   * than from anything the caller said, so a token cannot be presented on
   * behalf of a different principal than the one it was issued to — and, now
   * that there are two kinds of principal, cannot be presented as the wrong
   * *kind* either. A portal refresh token names a Contact in the column, so the
   * staff refresh path reading it finds no user arm and refuses.
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

    const subject = subjectOf(row);

    // Only reachable if the exclusive-arc check constraint were dropped. A
    // session with no subject is refused like an unrecognized token rather than
    // throwing, because the safe answer on a credential path is "no".
    if (!subject) return { outcome: 'unknown' };

    return {
      verdict: classifyPresentedToken(row, now),
      subject,
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

    const subject = subjectOf(predecessor);

    if (!subject) return null;

    // Tenant, subject and family all come off the predecessor row rather than
    // from the caller. A successor is by definition the same session as the
    // token it replaces, so there is no argument a caller could pass here that
    // would be anything but a way to get it wrong — including, now, the kind of
    // principal it belongs to.
    return this.write(tx, {
      tenantId: predecessor.tenantId,
      subject,
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
      subject: SessionSubject;
      now: Date;
      familyId: string;
      familyExpiresAt: Date;
    },
  ): Promise<IssuedRefreshToken> {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');

    await tx.refreshToken.create({
      data: {
        tenantId: input.tenantId,
        ...columnsFor(input.subject),
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

/**
 * The stored arc, read back as a subject — or `null` if the row has neither.
 *
 * The one place the two nullable columns are turned into the discriminated pair
 * everything else works with, so no caller ever holds a row and has to decide
 * which id is the real one.
 */
const subjectOf = (row: {
  userId: string | null;
  contactId: string | null;
}): SessionSubject | null => {
  if (row.userId) return { kind: 'user', userId: row.userId };
  if (row.contactId) return { kind: 'contact', contactId: row.contactId };

  return null;
};

/**
 * A subject as the columns that store it, with the unused arm explicitly null.
 *
 * Both columns are always named, rather than one being omitted, so the write
 * satisfies the exclusive-arc constraint by construction — a spread that
 * happened to carry a stale `userId` from elsewhere cannot survive this.
 */
const columnsFor = (
  subject: SessionSubject,
): { userId: string | null; contactId: string | null } =>
  subject.kind === 'user'
    ? { userId: subject.userId, contactId: null }
    : { userId: null, contactId: subject.contactId };
