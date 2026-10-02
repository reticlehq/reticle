/**
 * Quote one argument for a Windows command line. Pure, and deliberately NOT platform-gated, so the
 * Windows rule can be asserted on a mac or in CI's Linux job.
 *
 * `CommandLineToArgvW`: a run of backslashes is literal unless it precedes a `"`, in which case the
 * run is doubled and the quote escaped; a run at the very end sits before the closing quote added
 * here, so it is doubled too. An unescaped trailing `\` reads as an escaped quote and leaves the
 * rest of the line re-parsed by cmd.exe. Correctly-terminated quotes also neutralise cmd.exe's
 * metacharacters, so the trigger has to include them: `foo&whoami` contains no whitespace and no
 * quote, and went through unquoted.
 *
 * KNOWN LIMIT: `%VAR%` is expanded by cmd.exe even inside quotes, and no quoting prevents it — only
 * avoiding `shell: true` does, which Windows needs so `pnpm.cmd`/`npx.cmd` resolve (see `shellOpt`).
 * That is variable substitution, not command execution, and every caller here passes paths and
 * package names rather than user prose.
 */

/**
 * Characters that make cmd.exe do something other than pass the text along.
 *
 * Whitespace and `"` split or delimit; the rest are the shell's control operators. An argument
 * containing any of them must be quoted, not just one containing a space.
 */
const NEEDS_QUOTING = /[\s"&|<>^()!%,;=]/;

export function windowsShellArg(arg: string): string {
  // An empty argument must still occupy a slot in argv. Unquoted it disappears entirely, silently
  // shifting every argument after it by one.
  if (0 === arg.length) return '""';
  if (!NEEDS_QUOTING.test(arg)) return arg;
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if ('\\' === ch) {
      backslashes += 1;
      continue;
    }
    if ('"' === ch) {
      // 2n+1 backslashes → n literal backslashes and an escaped quote.
      out += '\\'.repeat(2 * backslashes + 1) + '"';
      backslashes = 0;
      continue;
    }
    out += '\\'.repeat(backslashes) + ch;
    backslashes = 0;
  }
  // A trailing run sits immediately before the closing quote, so it must be doubled or it escapes it.
  return `${out}${'\\'.repeat(2 * backslashes)}"`;
}
