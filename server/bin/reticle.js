#!/usr/bin/env node
// The agent hooks run on every prompt and every tool call, and some agents wait for them: answer
// them before the CLI loads. See src/command/cli/hook/hook-fast.ts.
if ('hook' === process.argv[2] && ('tool' === process.argv[3] || 'prompt' === process.argv[3])) {
  const { mainHookFast } = await import('../dist/command/cli/hook/hook-fast.js');
  await mainHookFast(process.argv[3], process.argv.slice(4));
} else {
  const { main } = await import('../dist/command/cli.js');
  main();
}
