// Loads the CLI. reticle.js checks the Node.js version before it requires this file, because an
// old Node.js cannot parse `import()`.
'use strict';

// The agent hooks run on every prompt and every tool call, and some agents wait for them: answer
// them before the CLI loads. See src/command/cli/hook/hook-fast.ts.
if ('hook' === process.argv[2] && ('tool' === process.argv[3] || 'prompt' === process.argv[3])) {
  import('../dist/command/cli/hook/hook-fast.js').then((hook) =>
    hook.mainHookFast(process.argv[3], process.argv.slice(4)),
  );
} else {
  import('../dist/command/cli.js').then((cli) => cli.main());
}
