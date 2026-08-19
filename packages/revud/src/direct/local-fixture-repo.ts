/**
 * A disposable, fully seeded git repository for the tests that must run a real
 * `git` rather than a fake `CommandRunner`. The git-only snapshot builder parses
 * git's own output formats, so the only way to assert it parses them correctly is
 * to produce them with the real program; a hand-written fixture string asserts
 * what its author believed git emits, which is exactly the belief under test.
 *
 * ## What is seeded
 *
 * A base branch and a head branch of three commits, whose combined diff against
 * the merge base carries one instance of every case the builder must classify:
 * a plain modification, an addition, a deletion, a rename detected by similarity,
 * a binary file (its bytes contain a NUL), a symlink (mode `120000`), a gitlink
 * (mode `160000`) and a type change (a symlink on the base side, a regular file on
 * the head side). The base branch also advances by one commit *after* the head
 * branch forks, so the merge base is strictly behind the base tip and a builder
 * that confuses the two cannot pass.
 *
 * A consumer must never assert over a case it assumes is present: a symlink is a
 * no-op on a filesystem without symlink support and a gitlink entry is silently
 * dropped if the index write fails, and either would leave a classification test
 * asserting over a change set that never contained the case — passing forever
 * while the logic it names is completely unguarded. The three environment-dependent
 * steps are therefore verified here, at the point of seeding, and throw rather
 * than degrade. The remaining cases are asserted by this module's own self-test.
 *
 * ## Why a type change is one of the seeded cases
 *
 * Replacing a symlinked file with a real one is an ordinary thing to do to a
 * repository, and it is the only change git reports with a different *number* of
 * records in different output formats: one `--raw` record and one `--numstat`
 * record, but two patch sections, because git spells the change as a deletion of
 * the old object class followed by a creation of the new one. A change set read
 * by joining those three streams is therefore wrong for this shape unless it was
 * built knowing about it, and a fixture that seeds only a symlink *addition*
 * cannot tell the difference.
 *
 * ## Why every commit carries explicit identity flags
 *
 * `-c user.email=… -c user.name=…` is passed on every commit because a CI runner
 * has no global git identity and `git commit` fails outright with "Please tell me
 * who you are" without one — a failure that appears only on the runner and never
 * on a developer machine. `commit.gpgsign=false` and `core.hooksPath=/dev/null`
 * suppress a developer's signing key and hooks for the same reason in reverse.
 *
 * ## Why every commit carries an explicit date, at a non-zero UTC offset
 *
 * Identity is pinned but the timezone is not, so without this every fixture
 * commit would be stamped with whatever offset the machine happens to run at.
 * That is not merely non-deterministic, it is unevenly informative: git prints
 * an author date in strict ISO 8601 (`%aI`), and strict ISO 8601 spells a zero
 * offset `Z`, never `+00:00`. A machine running in UTC therefore produces
 * commits whose printed date carries no offset at all, and a consumer asserting
 * that converting git's spelling to UTC *changes* it would be comparing a value
 * against itself — green, and asserting nothing, on exactly the machines where
 * the timezone handling is least exercised. Pinning a distinctive non-zero
 * offset puts a real offset in git's own stream everywhere, so such a
 * conversion is doing visible work on a developer's laptop and on a runner
 * alike, and a later change that let the machine's clock back in shows up as a
 * changed offset rather than as a silently weakened test.
 *
 * The instants are distinct and increasing, one commit to the next, because
 * consumers read the commits of a range as an ordered list and compare an
 * author date against other timestamps; commits sharing one instant would leave
 * that order resting on nothing.
 *
 * ## Why `GIT_CONFIG_GLOBAL` / `GIT_CONFIG_SYSTEM` are pinned at absent paths
 *
 * Identity flags are not isolation. Ambient configuration reaches every git
 * invocation, including the ones the code under test makes: a global
 * `diff.external` replaces the diff machinery wholesale, `log.showSignature`
 * prepends signature lines to `git log` output, `core.autocrlf` rewrites the bytes
 * a blob is stored with, and an alias can redefine a subcommand's name. Each of
 * those reshapes the very output the parsers are asserted against, so a suite can
 * be green on one machine and red — or, far worse, wrongly green — on another.
 * Pointing both config-path variables at paths that do not exist makes git read no
 * ambient configuration at all: a missing config file is an empty one.
 *
 * The two variables are set on this process's environment as well as on the
 * fixture's own spawns, because the production `CommandRunner` inherits the
 * process environment and takes no environment argument; pinning them here is the
 * only way the isolation reaches the git commands the code under test runs.
 * `dispose()` releases this fixture's pin; the value the process carried before
 * any fixture pinned it comes back when the last live pin is released, in
 * whatever order the fixtures are disposed.
 *
 * ## Why the gitlink is written with `update-index --cacheinfo`
 *
 * `git submodule add` refuses a local filesystem path as a submodule source
 * (`fatal: transport 'file' not allowed`) unless `protocol.file.allow` is
 * overridden, and overriding it to seed a fixture would relax a security default
 * for the whole invocation. `git update-index --add --cacheinfo 160000,<sha>,<path>`
 * writes the same index entry directly, needs no clone and no protocol override,
 * and `git diff --raw` then reports a genuine `160000` record. The oid it points
 * at is deliberately *not* an object this repository contains, which is the real
 * shape of a gitlink: a superproject records the submodule's commit oid without
 * holding the object, so handing that oid to `git cat-file blob` fails. A builder
 * that decides what to skip by looking for an all-zero SHA rather than at the file
 * mode cannot pass a test written against it.
 */
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** The author identity every fixture commit is made under. */
export const FIXTURE_AUTHOR_NAME = 'Fixture Author'

/**
 * The author email every fixture commit is made under. Deliberately distinctive
 * and in the reserved `.invalid` TLD, so a test asserting that an address never
 * reaches a response body can search for this exact string and a match can only
 * have come from the fixture.
 */
export const FIXTURE_AUTHOR_EMAIL = 'fixture-author@revu.invalid'

/** The commit oid recorded by the seeded gitlink. No object with this oid exists. */
export const FIXTURE_GITLINK_SHA = '0000000000000000000000000000000000000001'

/** Repository-relative paths of the seeded cases, so no consumer restates a literal. */
export interface FixtureRepoPaths {
  /** Present on both sides with different content — a plain modification. */
  readonly modified: string
  /** Absent on the base side, present on the head side. */
  readonly added: string
  /** Present on the base side, absent on the head side. */
  readonly removed: string
  /** The pre-image path of the rename. Absent on the head side. */
  readonly renamedFrom: string
  /** The post-image path of the rename, similar enough for `-M` to pair the two. */
  readonly renamedTo: string
  /** Added on the head side; its bytes contain a NUL, so git treats it as binary. */
  readonly binary: string
  /** Added on the head side as a symlink — file mode `120000`. */
  readonly symlink: string
  /** Added on the head side as a gitlink — file mode `160000`. */
  readonly gitlink: string
  /**
   * A symlink on the base side and a regular file on the head side — file mode
   * `120000` becoming `100644`, which git reports as a single `T` record and as
   * two patch sections.
   */
  readonly typechanged: string
  /** Added on the base branch after the head branch forked. Not in the head range. */
  readonly baseOnly: string
}

/** A seeded repository on disk, its resolved SHAs, and the teardown that removes it. */
export interface FixtureRepo {
  /**
   * The repository's toplevel directory, already resolved through its real path.
   * A temp directory is reached through a symlink on some platforms, and git
   * reports the resolved form, so an unresolved path would not compare equal to
   * what `git rev-parse --show-toplevel` prints.
   */
  readonly dir: string
  /**
   * The environment the fixture spawns git under. Carries `GIT_CONFIG_GLOBAL` and
   * `GIT_CONFIG_SYSTEM` at paths that do not exist; pass it to any spawn that
   * accepts an environment, so ambient configuration decides nothing there either.
   */
  readonly env: Record<string, string>
  /** The base branch's short name. */
  readonly baseBranch: string
  /** The head branch's short name. */
  readonly headBranch: string
  /** The base branch tip — strictly ahead of the merge base. */
  readonly baseSha: string
  /** The head branch tip. */
  readonly headSha: string
  /** `git merge-base` of the two tips. The left side of the reviewed range. */
  readonly mergeBaseSha: string
  /** The three head-branch commits, oldest first, ending at `headSha`. */
  readonly headCommitShas: readonly string[]
  readonly paths: FixtureRepoPaths
  /** Removes the repository and unwinds the environment pin. Safe to call once. */
  dispose(): void
}

const COMMIT_CONFIG: readonly string[] = [
  '-c',
  `user.email=${FIXTURE_AUTHOR_EMAIL}`,
  '-c',
  `user.name=${FIXTURE_AUTHOR_NAME}`,
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.hooksPath=/dev/null',
]

/**
 * The UTC offset every fixture commit is authored and committed at. Neither zero
 * — which git would print as `Z`, carrying no offset for a reader to convert —
 * nor a whole number of hours, so a machine-local offset accidentally taking its
 * place is recognisable on sight rather than plausible.
 */
const FIXTURE_COMMIT_OFFSET = '+05:45'

/**
 * The clock reading the first fixture commit is stamped with, held as epoch
 * milliseconds so the readings that follow it are plain arithmetic. Only the
 * date and time digits are used; the instant each commit names is that reading
 * at `FIXTURE_COMMIT_OFFSET`, not this one.
 */
const FIXTURE_FIRST_COMMIT_MS = Date.parse('2026-08-17T09:11:12Z')

/** How far apart consecutive fixture commits are stamped. */
const FIXTURE_COMMIT_SPACING_MS = 60_000

/**
 * The date the nth fixture commit is stamped with, counting from zero: a fixed
 * starting reading advanced by one spacing per commit, spelled at the fixture's
 * pinned offset. Strictly increasing in n, so the commits carry an order in time
 * that matches the order they are made in.
 */
function fixtureCommitDate(nth: number): string {
  const reading = new Date(FIXTURE_FIRST_COMMIT_MS + nth * FIXTURE_COMMIT_SPACING_MS)
  return `${reading.toISOString().slice(0, 19)}${FIXTURE_COMMIT_OFFSET}`
}

const PATHS: FixtureRepoPaths = {
  modified: 'src/plain.txt',
  added: 'src/added.txt',
  removed: 'src/removed.txt',
  renamedFrom: 'src/renamed-from.txt',
  renamedTo: 'src/renamed-to.txt',
  binary: 'assets/binary.bin',
  symlink: 'src/link',
  gitlink: 'vendor/sub',
  typechanged: 'src/config',
  baseOnly: 'docs/base-only.md',
}

/**
 * What the type-changed path holds once it is a regular file. Two lines, so the
 * addition count it produces (2) differs from the deletion count the symlink it
 * replaced produces (1) — a patch built from only one of git's two sections then
 * disagrees with the line counts, visibly, rather than by a number nobody reads.
 */
const TYPECHANGED_BODY = 'no longer a link\nplain content instead\n'

/**
 * The rename's shared body. Twelve identical lines against a single appended line
 * puts similarity far above `-M`'s 50% default, so the pairing is not sensitive to
 * a future change in git's scoring.
 */
const RENAME_BODY = Array.from({ length: 12 }, (_, i) => `rename-line-${i}`).join('\n') + '\n'

/**
 * The binary file's bytes: printable ASCII either side of two NULs. The NULs are
 * what make git call the file binary; keeping the rest ASCII means the bytes also
 * survive a UTF-8 decode, so a test may read the blob through the ordinary
 * text-decoding command runner and still observe the NUL.
 */
const BINARY_BYTES = new Uint8Array([0x62, 0x69, 0x6e, 0x00, 0x00, 0x74, 0x61, 0x69, 0x6c, 0x0a])

interface GitOutcome {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

async function spawnGit(args: readonly string[], env: Record<string, string>): Promise<GitOutcome> {
  const proc = Bun.spawn(['git', ...args], { env, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout, stderr }
}

/**
 * Runs one git command inside the fixture and returns its stdout, throwing on a
 * non-zero exit. A seeding step that fails must stop the fixture from being
 * handed out at all: a half-seeded repository turns every assertion made against
 * it into a claim about a change set that was never created.
 */
async function git(
  dir: string,
  env: Record<string, string>,
  args: readonly string[],
): Promise<string> {
  const outcome = await spawnGit(['-C', dir, ...args], env)
  if (outcome.code !== 0) {
    throw new Error(
      `fixture repo seeding failed: \`git ${args.join(' ')}\` exited ${outcome.code}: ${outcome.stderr.trim()}`,
    )
  }
  return outcome.stdout
}

/**
 * Every pin currently held on one environment variable, newest last, beside the
 * value the process carried before the first of them was taken.
 *
 * Overlapping pins have to be tracked in one place rather than each remembering
 * what it displaced. A pin that restores whatever it happened to displace
 * restores a *later* fixture's value when it is released first, and that value
 * names a directory that fixture has already deleted — so the variable is left
 * pointing at a path that no longer exists, for the rest of the process, quietly
 * suppressing ambient configuration for every unrelated suite that follows.
 * Whether the last release restores the original therefore cannot be a property
 * of the order they are released in.
 */
interface HeldPins {
  readonly prior: string | undefined
  /** One entry per live pin. Held as objects so two pins of the same value are two pins. */
  readonly pins: { readonly value: string }[]
}

const heldPins = new Map<string, HeldPins>()

/**
 * Sets one environment variable on this process and returns the undo.
 *
 * Releasing the last pin on a variable restores exactly what the process carried
 * before the first one was taken — deleting the variable where it carried
 * nothing. Releasing a pin while others are still held reinstates the newest of
 * those instead, so an overlapping fixture keeps its isolation whichever order
 * the two are disposed in. A second release of the same pin does nothing.
 */
function pinEnv(key: string, value: string): () => void {
  let held = heldPins.get(key)
  if (held === undefined) {
    held = { prior: process.env[key], pins: [] }
    heldPins.set(key, held)
  }
  const state = held
  const pin = { value }
  state.pins.push(pin)
  process.env[key] = value
  return (): void => {
    const at = state.pins.indexOf(pin)
    if (at === -1) return
    state.pins.splice(at, 1)
    const newest = state.pins[state.pins.length - 1]
    if (newest !== undefined) {
      process.env[key] = newest.value
      return
    }
    heldPins.delete(key)
    if (state.prior === undefined) delete process.env[key]
    else process.env[key] = state.prior
  }
}

/**
 * Seeds a fresh repository under the system temp directory and resolves once every
 * case is committed and verified. Call `dispose()` from an `afterAll` — the
 * directory is not cleaned up by anything else.
 */
export async function createFixtureRepo(): Promise<FixtureRepo> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'revu-local-fixture-')))

  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  // Inside the fixture directory, and never created — git reads a missing config
  // file as an empty one, which is exactly the "no ambient configuration" state.
  env.GIT_CONFIG_GLOBAL = join(dir, 'absent-global-gitconfig')
  env.GIT_CONFIG_SYSTEM = join(dir, 'absent-system-gitconfig')
  const unpin = [
    pinEnv('GIT_CONFIG_GLOBAL', env.GIT_CONFIG_GLOBAL),
    pinEnv('GIT_CONFIG_SYSTEM', env.GIT_CONFIG_SYSTEM),
  ]

  const write = (path: string, body: string): void => {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), body)
  }
  const run = (args: readonly string[]): Promise<string> => git(dir, env, args)
  let commitsMade = 0
  /**
   * Commits the index, stamping the author and the committer with the same
   * pinned instant. Both are set, and by environment variable, because
   * `--date` reaches only the author date and git would fall back to the
   * machine's clock for the committer.
   */
  const commit = (message: string): Promise<string> => {
    const stamped = fixtureCommitDate(commitsMade++)
    return git(dir, { ...env, GIT_AUTHOR_DATE: stamped, GIT_COMMITTER_DATE: stamped }, [
      ...COMMIT_CONFIG,
      'commit',
      '-q',
      '-m',
      message,
    ])
  }
  const head = async (): Promise<string> => (await run(['rev-parse', 'HEAD'])).trim()
  /**
   * Creates a symlink and refuses to continue unless it really is one. A
   * filesystem without symlink support turns the call into a no-op or into an
   * ordinary file, and either would leave the mode-`120000` cases asserting over
   * a change set that never carried them.
   */
  const link = (target: string, path: string): void => {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    symlinkSync(target, join(dir, path))
    if (!lstatSync(join(dir, path)).isSymbolicLink()) {
      throw new Error(
        `fixture repo seeding failed: ${path} is not a symlink — this filesystem cannot carry the mode 120000 case`,
      )
    }
  }

  try {
    const init = await spawnGit(['init', '-q', '-b', 'main', dir], env)
    if (init.code !== 0) {
      throw new Error(`fixture repo seeding failed: \`git init\` exited ${init.code}: ${init.stderr.trim()}`)
    }

    // ——— The base branch's root commit: the pre-image of every change below.
    write(PATHS.modified, 'alpha\nbravo\ncharlie\n')
    write(PATHS.removed, 'gone-one\ngone-two\n')
    write(PATHS.renamedFrom, RENAME_BODY)
    // The pre-image of the type change: a link, in the shape a repository that
    // points a config path at a checked-in file has. The head branch replaces it
    // with the file itself.
    link('plain.txt', PATHS.typechanged)
    await run(['add', '-A'])
    await commit('seed the base branch')
    const rootSha = await head()

    // ——— The head branch: three commits, so a consumer asserting commit order
    // can distinguish a reversal from an off-by-one in the middle.
    await run(['checkout', '-q', '-b', 'feature/x'])

    write(PATHS.modified, 'alpha\nBRAVO-CHANGED\ncharlie\n')
    write(PATHS.added, 'added-one\nadded-two\n')
    await run(['add', '-A'])
    await commit('modify one file and add another')
    const firstHeadSha = await head()

    rmSync(join(dir, PATHS.removed))
    await run(['mv', PATHS.renamedFrom, PATHS.renamedTo])
    write(PATHS.renamedTo, `${RENAME_BODY}rename-line-appended\n`)
    await run(['add', '-A'])
    await commit('delete one file and rename another')
    const secondHeadSha = await head()

    mkdirSync(join(dir, PATHS.binary, '..'), { recursive: true })
    writeFileSync(join(dir, PATHS.binary), BINARY_BYTES)
    // A relative target inside the same directory, so the link resolves whatever
    // the repository's absolute location turns out to be.
    link('plain.txt', PATHS.symlink)
    // The link the base branch carries stops being a link and becomes the file.
    // Removed first: writing through it would follow it and rewrite its target.
    rmSync(join(dir, PATHS.typechanged))
    write(PATHS.typechanged, TYPECHANGED_BODY)
    await run(['add', '-A'])
    // Written after `add -A`, which would otherwise stage the gitlink's absence
    // from the worktree and remove the entry that was just created.
    await run(['update-index', '--add', '--cacheinfo', `160000,${FIXTURE_GITLINK_SHA},${PATHS.gitlink}`])
    const staged = await run(['ls-files', '-s', '--', PATHS.gitlink])
    if (!staged.startsWith('160000 ')) {
      throw new Error(
        `fixture repo seeding failed: ${PATHS.gitlink} was staged as ${JSON.stringify(staged)}, not as a mode 160000 gitlink`,
      )
    }
    await commit('add a binary file, a symlink and a gitlink, and unlink one path')
    const headSha = await head()

    // ——— Advance the base branch after the fork, so the merge base is strictly
    // behind the base tip. A builder that reads the base tip where it should read
    // the merge base then produces a visibly different change set.
    await run(['checkout', '-q', 'main'])
    write(PATHS.baseOnly, 'a change only the base branch carries\n')
    await run(['add', '-A'])
    await commit('advance the base branch past the fork point')
    const baseSha = await head()

    const mergeBaseSha = (await run(['merge-base', baseSha, headSha])).trim()
    if (mergeBaseSha !== rootSha) {
      throw new Error(
        `fixture repo seeding failed: merge base is ${mergeBaseSha}, expected the root commit ${rootSha}`,
      )
    }

    // A path can stop being a symlink without git calling it a type change: had
    // the pre-image never been committed as a link, the same two commits would
    // read as an ordinary modification and the case would be silently absent.
    const typechange = await run([
      'diff',
      '--raw',
      '--no-abbrev',
      '-M',
      mergeBaseSha,
      headSha,
      '--',
      PATHS.typechanged,
    ])
    if (!/^:120000 100644 [0-9a-f]{40} [0-9a-f]{40} T\t/.test(typechange)) {
      throw new Error(
        `fixture repo seeding failed: ${PATHS.typechanged} is reported as ${JSON.stringify(typechange)}, not as a 120000 → 100644 type change`,
      )
    }

    return {
      dir,
      env,
      baseBranch: 'main',
      headBranch: 'feature/x',
      baseSha,
      headSha,
      mergeBaseSha,
      headCommitShas: [firstHeadSha, secondHeadSha, headSha],
      paths: PATHS,
      dispose(): void {
        for (const undo of unpin) undo()
        rmSync(dir, { recursive: true, force: true })
      },
    }
  } catch (err) {
    for (const undo of unpin) undo()
    rmSync(dir, { recursive: true, force: true })
    throw err
  }
}
