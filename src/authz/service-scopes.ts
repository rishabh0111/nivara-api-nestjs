import { PERMISSIONS, Permission, SUPPORT_WORK } from './permissions';

/**
 * Which permissions a machine credential may hold, and which it never may.
 *
 * The whole file exists to make one sentence true: a scope is a permission
 * drawn from the staff vocabulary, not a parallel namespace. There is no
 * `ServiceScope` type here, because there is nothing for it to be — a scope
 * *is* a `Permission`, and giving it a second name would be the first step
 * toward two catalogs that have to be kept in step.
 */

/**
 * What an admin may grant a service token: exactly the support work.
 *
 * Written as the support list rather than re-spelled, and that coupling is the
 * design. The AI layer does an agent's job, so the honest bound on a machine
 * credential is "no more than an agent" — and a permission added to support
 * work is one an agent does all day, which is precisely the class a token
 * should be able to hold. Spelling a second list out in full is how the two
 * drift, and the drift would be silent in the direction that matters: a new
 * support permission that tooling can never be granted, reported as a bug
 * months later.
 *
 * What is *not* here is the point of the ticket, and it falls out of the same
 * line: everything an agent cannot do — closing a Ticket for good, deleting
 * one, inviting or deactivating staff, changing SLA policy, minting tokens,
 * reading the audit log — is un-grantable to a machine, because it is already
 * withheld from the role a machine is modelled on. `token:manage` is the one
 * worth naming aloud: a token able to mint a token could give itself a
 * successor, and revoking it would not end the machine's access.
 */
export const ASSIGNABLE_SCOPES: readonly Permission[] = [...SUPPORT_WORK];

/**
 * The complement, derived rather than listed.
 *
 * Exists so "un-grantable" is a set with one definition rather than a second
 * list that could disagree with the first about a permission added next month.
 * Its consumer is `service-scopes.spec.ts`, which asserts that the two
 * partition the catalog with nothing left over — that assertion is what turns
 * this from an unused constant into the thing that catches a permission added
 * to the catalog and to neither side.
 */
export const UNGRANTABLE_SCOPES: readonly Permission[] = PERMISSIONS.filter(
  (permission) => !ASSIGNABLE_SCOPES.includes(permission),
);

/**
 * What a requested scope list turns out to be.
 *
 * Four outcomes rather than a boolean, because the caller is an authenticated
 * admin of this tenant configuring their own integration — there is nothing to
 * conceal from them, and "rejected" without a reason would leave them guessing
 * which of several names was the problem. Contrast the invitation path, where
 * every failure collapses into one answer precisely because the caller there
 * has no credential.
 */
export type ScopeVerdict =
  | { outcome: 'accept'; scopes: Permission[] }
  /** A name that is not in the catalog at all — almost always a typo. */
  | { outcome: 'unknown'; offending: string[] }
  /** A real permission that no machine credential may hold. */
  | { outcome: 'forbidden'; offending: string[] }
  /** A token with no scopes could authenticate and then do nothing. */
  | { outcome: 'empty' };

/**
 * Decides whether a requested grant may be minted.
 *
 * Unknown names are reported ahead of forbidden ones so a typo is described as
 * a typo rather than as a policy refusal, which would send an admin looking for
 * a setting to change instead of a letter to fix.
 *
 * Duplicates are collapsed rather than refused. A repeated scope is not a
 * mistake worth a round trip — it means what it says once — and the stored
 * column should hold a set, so that `grantedScopes` below cannot answer with
 * the same authority twice.
 */
export const classifyScopes = (requested: readonly string[]): ScopeVerdict => {
  const deduplicated = [...new Set(requested)];

  if (deduplicated.length === 0) return { outcome: 'empty' };

  const unknown = deduplicated.filter(
    (scope) => !(PERMISSIONS as string[]).includes(scope),
  );

  if (unknown.length > 0) return { outcome: 'unknown', offending: unknown };

  const scopes = deduplicated as Permission[];
  const forbidden = scopes.filter(
    (scope) => !ASSIGNABLE_SCOPES.includes(scope),
  );

  if (forbidden.length > 0)
    return { outcome: 'forbidden', offending: forbidden };

  return { outcome: 'accept', scopes };
};

/**
 * The authority a stored row actually confers, narrowed on every read.
 *
 * Not redundant with `classifyScopes`, and the difference is worth stating.
 * That function guards the one write path *this* application offers; this one
 * guards what the column says, whoever wrote it — a migration, a support
 * script, the Spring or FastAPI port, or a hand-edited row. "No machine
 * credential can ever hold `audit:read`" should not rest on every writer having
 * been careful, so it is re-decided here at the moment the authority is used.
 *
 * A scope the catalog no longer contains is dropped for the same reason
 * `permissionsFor` tolerates an unknown role: a retired permission must resolve
 * to *no* authority, not to an exception that surfaces as a 500 and refuses the
 * request without anybody having audited the refusal.
 */
export const grantedScopes = (stored: readonly string[]): Permission[] =>
  stored.filter((scope): scope is Permission =>
    ASSIGNABLE_SCOPES.includes(scope as Permission),
  );
