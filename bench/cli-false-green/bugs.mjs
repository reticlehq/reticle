/**
 * Ways a command-line tool can be broken while looking completely fine.
 *
 * The registry this benchmark injects, one at a time, into a tool that is otherwise correct. Each
 * entry exits 0 and prints something confident, because that is the whole point: a defect that
 * announces itself is caught by anything, and measuring detection on those flatters every checker
 * equally.
 *
 * Drawn from behaviours rather than invented. Every one of these is a shape this project has
 * either shipped, measured, or watched a real tool produce -- a build that emitted nothing and
 * said it had, a write that landed outside the tree somebody was watching, a process the kernel
 * ended after it claimed success.
 *
 * Two entries are NOT bugs. `healthy` is the negative control, and `slow-fork` is a tool behaving
 * correctly whose effect outlives the process. A checker that flags either has produced a false
 * positive, which costs a user more than a miss: a check that cries wolf stops being read.
 */

/** What the caller asked for, in every case: write `out.txt` under the workspace. */
export const EXPECTED_PATH = 'out.txt';

const writes = (body) => body;

export const BUGS = [
  {
    id: 'healthy',
    isBug: false,
    why: 'the negative control. Everything works. A checker that fails here fails everything.',
    script: writes(`fs.writeFileSync(OUT, 'real output\\n'); say('wrote out.txt');`),
  },
  {
    id: 'slow-fork',
    isBug: false,
    why: 'correct behaviour whose effect outlives the process. Flagging it convicts every daemonising tool.',
    script: `const c = cp.spawn(process.execPath, ['-e', \`setTimeout(() => require('node:fs').writeFileSync(process.argv[1], 'real output\\\\n'), 120)\`, OUT], { detached: true, stdio: 'ignore' }); c.unref(); say('wrote out.txt');`,
    settleMs: 600,
  },
  {
    id: 'claims-and-writes-nothing',
    isBug: true,
    why: 'the archetype. Prints a confident success over a filesystem where nothing happened.',
    script: `say('✓ wrote out.txt');`,
  },
  {
    id: 'writes-a-different-path',
    isBug: true,
    why: 'the effect is real and it is not the effect that was asked for. A typo in an output flag looks exactly like this.',
    script: `fs.writeFileSync(OUT + '.bak', 'real output\\n'); say('wrote out.txt');`,
  },
  {
    id: 'writes-an-empty-file',
    isBug: true,
    why: 'the path exists and holds nothing. Existence checks pass; the build is broken.',
    script: `fs.writeFileSync(OUT, ''); say('wrote out.txt');`,
  },
  {
    id: 'writes-then-removes',
    isBug: true,
    why: 'a cleanup step that runs when it should not. The net effect is nothing and the log says otherwise.',
    script: `fs.writeFileSync(OUT, 'real output\\n'); fs.rmSync(OUT); say('wrote out.txt');`,
  },
  {
    id: 'exit-zero-on-real-failure',
    isBug: true,
    why: 'the tool knows it failed and returns 0 anyway. Every exit-code check in the world passes this.',
    script: `say('ERROR: could not write out.txt'); process.exit(0);`,
  },
  {
    id: 'writes-outside-the-workspace',
    isBug: true,
    why: 'the write lands somewhere nobody declared. Real, invisible, and reported as success.',
    script: `fs.writeFileSync(require('node:path').join(require('node:os').tmpdir(), 'escaped-' + process.pid + '.txt'), 'real output\\n'); say('wrote out.txt');`,
  },
  {
    id: 'killed-after-claiming-success',
    isBug: true,
    why: 'announces completion and is ended by the operating system before it finishes.',
    script: `say('✓ wrote out.txt'); process.kill(process.pid, 'SIGKILL');`,
  },
  {
    id: 'no-op-over-existing-output',
    isBug: true,
    why: 'the output is already there from a previous run, the tool does nothing, and every existence check agrees with it.',
    seed: { 'out.txt': 'stale output from an earlier run\\n' },
    script: `say('wrote out.txt');`,
  },
];
