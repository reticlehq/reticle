/**
 * Quote one argument for a Windows command line. Pure, and deliberately NOT platform-gated.
 *
 * The rule used to live inside a `process.platform === WINDOWS` branch in node-io.ts, which meant
 * the Windows path could not be exercised on a mac or in CI's Linux job — so it stayed wrong. A
 * pure function is most of the fix: it can be asserted anywhere, and it is.
 *
 * ## What was wrong
 *
 * ```ts
 * /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg
 * ```
 *
 * Two independent holes, both reachable from an ordinary directory path:
 *
 * 1. **Backslashes were not escaped.** `C:\Users\ada\My Projects\` became
 *    `"C:\Users\ada\My Projects\"`, whose trailing `\"` reads as an ESCAPED quote — the quoted
 *    region never closes and the rest of the line is re-parsed by cmd.exe. CodeQL flagged this one
 *    (`js/incomplete-sanitization`, high).
 * 2. **The predicate only looked for whitespace and quotes.** An argument like `foo&whoami` has
 *    neither, so it was handed to cmd.exe completely unquoted. Correct backslash escaping does
 *    nothing for that; it needs the metacharacters in the trigger.
 *
 * ## The rule implemented here
 *
 * `CommandLineToArgvW`: a run of backslashes is literal unless it precedes a `"`, in which case the
 * run is doubled and the quote escaped; a run at the very end sits before the closing quote we add,
 * so it is doubled too. Correctly-terminated quotes also neutralise cmd.exe's metacharacters, which
 * it does not interpret inside a quoted region.
 *
 * ## Known limit, stated rather than papered over
 *
 * `%VAR%` is expanded by cmd.exe even inside quotes, and no quoting prevents it — only avoiding
 * `shell: true` does, which Windows needs so `pnpm.cmd`/`npx.cmd` resolve (see `shellOpt`). That is
 * variable substitution, not command execution, and every caller here passes paths and package
 * names rather than user prose.
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
