import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..');

/** The seam's own directory — the one place `getOrLoad` is expected to appear. */
const CACHE_DIR = __dirname;

/**
 * Directories with nothing to say about caching. `generated` is Prisma's
 * output — large, not ours, and regenerated on every schema change.
 */
const SKIPPED = new Set(['generated', 'node_modules']);

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      return SKIPPED.has(entry.name) ? [] : sourceFiles(path);
    }

    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
  });

/**
 * The acceptance criterion "nothing is cached in v1", as an assertion.
 *
 * A test rather than a note in a document, because the claim decays silently:
 * the first cached read will be added by someone solving a latency problem, and
 * nothing about writing it would prompt them to reread the seam's three-clause
 * contract. This fails their build instead, in the one place that names the
 * clauses.
 *
 * It is not a prohibition — clause (c) exists precisely to be exercised. It is
 * a checkpoint. A caller who has read the contract and satisfied it deletes
 * this test and says so in the commit.
 */
describe('the cache seam', () => {
  it('is called by no production read path', () => {
    const callers = sourceFiles(SRC)
      .filter(
        (path) => !path.startsWith(CACHE_DIR) && !path.endsWith('spec.ts'),
      )
      .filter((path) => /\bgetOrLoad\b/.test(readFileSync(path, 'utf8')));

    expect(callers).toEqual([]);
  });
});
