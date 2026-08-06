import { config as loadDotenv } from 'dotenv';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * SIDE-EFFECT MODULE: loads the monorepo-root `.env` before anything reads
 * `process.env`. Import it first, above every other import that might touch
 * configuration.
 *
 * This exists because the alternative silently half-works. dotenv resolves
 * `.env` relative to the *current working directory*, and `npm run migrate
 * --workspace=@voltix/db` runs with cwd set to `packages/db`. The root `.env`
 * is therefore invisible, and what you get is not a clear error — it is a
 * migration runner that connects to the fallback development URL, or a
 * storefront that quietly serves its demo catalogue. Both look fine.
 *
 * Walking up from this file rather than from cwd makes the result independent
 * of how the process was launched: npm workspace script, tsx, vitest, or a
 * direct `node` invocation all resolve the same file.
 *
 * `override: false` throughout, so a variable already exported in the shell —
 * or injected by the deployment platform, which is how production works — wins
 * over the file. In production there is usually no `.env` at all and this is a
 * no-op, which is the intended behaviour.
 */
function findRepoRoot(start: string): string | null {
  let dir = start;
  for (let depth = 0; depth < 10; depth += 1) {
    // package-lock.json rather than package.json: every workspace has the
    // latter, only the root has the lock file.
    if (existsSync(join(dir, 'package-lock.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const root = findRepoRoot(dirname(fileURLToPath(import.meta.url)));

if (root) {
  // `.env.local` is gitignored and layered on top for machine-specific
  // overrides — a different database port, a personal API key — without
  // touching the shared file. Loaded first because `override: false` means
  // whatever is set first wins.
  loadDotenv({ path: join(root, '.env.local'), override: false, quiet: true });
  loadDotenv({ path: join(root, '.env'), override: false, quiet: true });
}

export const repoRoot = root;
