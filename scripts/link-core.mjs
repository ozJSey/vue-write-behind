/**
 * Make `@ozjsey/write-behind` resolvable the way Node resolves it, then rebuild
 * it.
 *
 * The engine is a real `dependencies` entry (`^0.1.0`), so once it is on the
 * registry an ordinary `npm install` is all any of this needs. **Until then it
 * is not installable**, and two checks here resolve it by bare specifier
 * through Node rather than through a bundler alias:
 *
 *   - `dist-check.mjs` imports the built `dist/vueWriteBehind.min.js`, which
 *     carries `import { createWriteBehind } from '@ozjsey/write-behind'`;
 *   - `playground.html` maps the same specifier for the browser check.
 *
 * So: symlink the sibling into `node_modules/@ozjsey/`, exactly as `npm link`
 * would, and rebuild it. The rebuild is not politeness — these two checks exist
 * to catch a stale `dist/`, and letting them read a stale *sibling* `dist/`
 * would reintroduce the bug one package further out.
 *
 * The unit suites do not go through here: they alias the engine to its source
 * (`vitest.workspace.ts`), which is the working tree rather than any artifact.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, lstatSync, symlinkSync, unlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('..', import.meta.url))
const core = fileURLToPath(new URL('../../write-behind', import.meta.url))
const scope = new URL('../node_modules/@ozjsey/', import.meta.url)
const link = fileURLToPath(new URL('write-behind', scope))

if (!existsSync(core)) {
  console.error(
    `link-core: no sibling checkout at ${core}.\n` +
      'Once @ozjsey/write-behind is published, `npm install` replaces this script entirely.',
  )
  process.exit(1)
}

mkdirSync(fileURLToPath(scope), { recursive: true })
if (existsSync(link) || lstatSync(link, { throwIfNoEntry: false })) unlinkSync(link)
symlinkSync(core, link, 'dir')
console.log(`link-core: ${link} -> ${core}`)

execFileSync('npm', ['run', 'build'], { cwd: core, stdio: 'inherit' })
console.log(`link-core: rebuilt the engine for ${here}`)
