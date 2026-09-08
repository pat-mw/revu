/**
 * The pure predicate that decides whether a git argv array is in its hardened
 * form. The command runner spawns an argv array with no shell, which rules out
 * shell injection but not option injection: a rev or path operand beginning
 * with `-` is read by git as a flag, and flags such as `--upload-pack=<cmd>`
 * and `--output=<path>` turn an operand position into code execution or a file
 * overwrite. The hardened form closes that read: every rev operand sits behind
 * `--end-of-options` (honored by git ≥ 2.24) and every pathspec behind `--`,
 * so nothing in an operand position can be consumed as an option.
 *
 * This is a predicate rather than a convention so that a test can assert the
 * invariant over every captured argv by calling one function, instead of each
 * test restating the rule — a rule restated in many places is not a rule. It
 * classifies operands by shape: a fully-qualified ref (`refs/…`), a full-length
 * object name, or a range of two object names is a rev; anything else in an
 * operand position is treated as a pathspec and must follow `--`. Every value
 * that can carry caller input through this seam arrives in one of the rev
 * shapes (normalization fully qualifies ref names, and resolution produces
 * full-length object names), so the shape rule covers exactly the values that
 * need guarding.
 *
 * One subcommand needs its own rule: `git check-ref-format` does not implement
 * `--end-of-options` (it exits 129 on it — a fact the test suite pins against
 * real git), so its only spawnable safe shape is a `refs/`-qualified operand
 * with no marker at all. A `refs/…` string cannot begin with `-` and therefore
 * cannot be read as an option, which is what makes that shape safe; every
 * other argument to that subcommand is rejected here, options included,
 * because this seam never has a reason to pass one.
 */

export type HardenedArgvVerdict = { ok: true } | { ok: false; reason: string }

const FULL_OBJECT_NAME = /^[0-9a-f]{40}$/
const OBJECT_NAME_RANGE = /^[0-9a-f]{40}\.{2,3}[0-9a-f]{40}$/

/** True for the operand shapes this seam uses to carry revs. */
function isRevShaped(token: string): boolean {
  return (
    token.startsWith('refs/') || FULL_OBJECT_NAME.test(token) || OBJECT_NAME_RANGE.test(token)
  )
}

/**
 * Decides whether an argv array is in the hardened form described above.
 * Returns `{ ok: true }` or a rejection whose reason names the offending token,
 * so a failing sweep over captured argv arrays reports which call was wrong.
 */
export function isHardenedArgv(args: readonly string[]): HardenedArgvVerdict {
  if (args[0] !== 'git') {
    return { ok: false, reason: `argv must invoke "git", not ${JSON.stringify(args[0] ?? '')}` }
  }

  // Locate the subcommand: skip the global option prefix, where `-c` and `-C`
  // each consume a following value and every other option is self-contained.
  let index = 1
  while (index < args.length && args[index].startsWith('-')) {
    index += args[index] === '-c' || args[index] === '-C' ? 2 : 1
  }
  const subcommand = args[index]

  // A rev-shaped token in the subcommand position is never something this seam
  // emits; with ambient configuration pinned off there is no alias for it to
  // resolve to, and accepting it would let a rev bypass the marker rule below.
  if (subcommand !== undefined && isRevShaped(subcommand)) {
    return {
      ok: false,
      reason: `rev argument ${JSON.stringify(subcommand)} is not preceded by --end-of-options`,
    }
  }

  if (subcommand === 'check-ref-format') {
    for (let j = index + 1; j < args.length; j++) {
      if (!args[j].startsWith('refs/')) {
        return {
          ok: false,
          reason: `check-ref-format accepts no --end-of-options, so every argument must be refs/-qualified; got ${JSON.stringify(args[j])}`,
        }
      }
    }
    return { ok: true }
  }

  let sawEndOfOptions = false
  let sawPathspecSeparator = false
  for (let j = index + 1; j < args.length; j++) {
    const token = args[j]
    // Everything after `--` is a pathspec and git reads it literally.
    if (sawPathspecSeparator) continue
    if (!sawEndOfOptions && token === '--end-of-options') {
      sawEndOfOptions = true
      continue
    }
    // Git still honors `--` as the rev/path separator after `--end-of-options`.
    if (token === '--') {
      sawPathspecSeparator = true
      continue
    }
    if (sawEndOfOptions) {
      // The operand region between the two markers belongs to revs alone. A
      // non-rev token here — a path, or something spelled like an option that
      // git would now read as an operand — belongs after `--` instead.
      if (!isRevShaped(token)) {
        return { ok: false, reason: `pathspec ${JSON.stringify(token)} must be preceded by "--"` }
      }
      continue
    }
    // Before `--end-of-options`: options and the subcommand's own word operands
    // (a remote name, an option value) are fine, but no rev may appear where
    // git's option parser is still running.
    if (isRevShaped(token)) {
      return {
        ok: false,
        reason: `rev argument ${JSON.stringify(token)} is not preceded by --end-of-options`,
      }
    }
  }

  return { ok: true }
}
