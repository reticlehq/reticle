// Computer benchmark: Reticle's tree-and-ref tools against Claude's own computer-use toolset.
//
// Both arms use the same model, the same task text and the same Reticle helper to act. Only the
// tools that the model sees are different:
//   reticle — `look` (the accessibility tree, with refs) and `act` (an action on a ref, which
//             answers with what changed).
//   cu-toolset — Claude's `computer_toolset_20260801` schema: screenshots, and clicks at points
//             of them. Reticle's helper carries out each action, NOT Anthropic's own computer-use
//             setup. So this compares two ways to choose actions on one executor. Say exactly
//             that wherever a number from this file goes.
// A checker outside both arms reads the result from the disk, or from the answer. It never asks
// Reticle. Two tasks cannot be done; for them the correct answer is "failed", so a "done" there is
// a false done.
//
// It needs the operator from the computer run (a bridge, and HTTP on 4499 that joins an app
// and runs a tool), the screen for itself, and ANTHROPIC_API_KEY.
//
//   node --env-file=../../.env bench/computer/cu-bench.mjs [arm] [taskId]
//
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// BENCH_PROVIDER=openai runs the arms with an OpenAI model, and adds OpenAI's own computer tool.
const OPENAI = 'openai' === process.env.BENCH_PROVIDER;
const KEY = OPENAI ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.BENCH_MODEL ?? (OPENAI ? 'gpt-5.4' : 'claude-opus-5-5');
const EFFORT = process.env.BENCH_EFFORT ?? 'medium';
const MAX_TURNS = Number(process.env.BENCH_MAX_TURNS ?? 30);
const OPERATOR = 'http://127.0.0.1:4499';
const DIR = '/tmp/reticle-cu-bench';
const SHOT_WIDTH = 1280;
const OUT = new URL('./results.jsonl', import.meta.url);
// Each run's whole conversation, pictures left out, to read why an arm passed or failed.
const TRANSCRIPTS = new URL('./transcripts/', import.meta.url);
const RUN = new Date().toISOString().replace(/[:.]/g, '-');
function saveTranscript(arm, task, turns) {
  mkdirSync(TRANSCRIPTS, { recursive: true });
  const text = JSON.stringify(turns, (key, value) =>
    ('data' === key || 'image_url' === key) && 'string' === typeof value && value.length > 200
      ? '[picture]'
      : value,
  );
  writeFileSync(new URL(`${RUN}-${arm}-${task}.json`, TRANSCRIPTS), text);
}

if (!KEY) {
  const provider = OPENAI ? 'OPENAI' : 'ANTHROPIC';
  console.log(`NOT MEASURED: the ${provider} API key is not set.`);
  process.exit(0);
}

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
// The bench runs on the person's own Mac. It closes only what it opened: the TextEdit documents
// and the Finder windows of its own folder. Before, it quit TextEdit "saving no" and closed every
// Finder window, so a document of the person with changes not saved was lost.
const OWN = '/reticle-cu-bench/';
const jxa = (script) => sh('osascript', ['-l', 'JavaScript', '-e', script]).trim();
/** How many TextEdit documents and Finder windows are the person's, not the bench's. */
function notOurs() {
  return {
    documents: Number(
      jxa(
        `const t = Application("TextEdit"); t.running() ? t.documents().filter((d) => { try { return !String(d.path()).includes("${OWN}"); } catch (e) { return true; } }).length : 0`,
      ),
    ),
    windows: Number(
      jxa(
        `Application("Finder").finderWindows().filter((w) => { try { return !decodeURI(w.target().url()).includes("${OWN}"); } catch (e) { return true; } }).length`,
      ),
    ),
  };
}
const quit = (app) => {
  try {
    if ('TextEdit' === app) {
      // Its own documents only. TextEdit quits only when no other document is open.
      jxa(
        `const t = Application("TextEdit"); if (t.running()) { for (const d of t.documents()) { try { if (String(d.path()).includes("${OWN}")) d.close({ saving: "no" }); } catch (e) {} } if (0 === t.documents().length) t.quit(); }`,
      );
      return;
    }
    // Calculator holds no document.
    sh('osascript', ['-e', `tell application "${app}" to quit`]);
  } catch {
    // ponytail: the app was not running.
  }
};
const read = (path) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined);

async function post(path, body) {
  const r = await fetch(`${OPERATOR}/${path}`, { method: 'POST', body: JSON.stringify(body) });
  return r.json();
}
const tool = (name, args) => post('tool', { name, args });

// Setup and checkers: outside the arms. The shell sets the stage; it never does the task.
function fresh(task) {
  const dir = join(DIR, task);
  if (existsSync(dir)) {
    sh('chflags', ['-R', 'nouchg', dir]);
  }
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}
async function openIn(app, path) {
  quit(app);
  await sleep(1200);
  sh('open', path === undefined ? ['-a', app] : ['-a', app, path]);
  await sleep(2500);
}
async function finderAt(dir) {
  // The Finder windows of the bench's own folder only.
  jxa(
    `for (const w of Application("Finder").finderWindows()) { try { if (decodeURI(w.target().url()).includes("${OWN}")) w.close(); } catch (e) {} }`,
  );
  sh('open', [dir]);
  await sleep(2000);
}

/** The first window of an application, as System Events gives it. Absent: it has no window. */
/**
 * The window of the task by its name, as System Events gives it. Not "window 1": TextEdit kept
 * windows of earlier runs, and a minimized one of them passed the minimize task of another arm.
 */
function windowOf(app, name) {
  try {
    const [x, y, width, height, minimized] = sh('osascript', [
      '-e',
      `tell application "System Events" to tell (first window of process "${app}" whose name is "${name}") to return position & size & {value of attribute "AXMinimized"}`,
    ])
      .trim()
      .split(/,\s*/);
    return { x: +x, y: +y, width: +width, height: +height, minimized: minimized === 'true' };
  } catch {
    return undefined;
  }
}
/**
 * What the display of Calculator shows, from System Events: outside every arm. An answer alone is
 * not the proof: a model can work out 1234 × 56 without Calculator.
 */
function calculatorShows() {
  try {
    return sh('osascript', [
      '-l',
      'JavaScript',
      '-e',
      'const out = []; for (const e of Application("System Events").processes["Calculator"].windows[0].entireContents()) { try { if (e.role() === "AXStaticText") out.push(String(e.value())) } catch (x) {} } out.join("\\n")',
    ]).replace(/[\u200e\u200f]/g, '');
  } catch {
    return '';
  }
}

/** The size of the main screen, from the bounds of the desktop. */
function screenSize() {
  const [, , width, height] = sh('osascript', [
    '-e',
    'tell application "Finder" to get bounds of window of desktop',
  ])
    .trim()
    .split(/,\s*/)
    .map(Number);
  return { width, height };
}

// The small application of the realm's own checks, for the trap: with `broken`, its Export says
// "Exported" and writes nothing. Its window floats and it never takes the keyboard.
const FIXTURE_DIR = new URL('../../adapters/realm/computer/native/mac/', import.meta.url).pathname;
const FIXTURE = `${FIXTURE_DIR}build/fixture`;
let fixtureBuilt = false;
async function openFixture(dir, mode) {
  try {
    sh('pkill', ['-f', FIXTURE]);
  } catch {
    // ponytail: no fixture was running.
  }
  if (!fixtureBuilt) {
    mkdirSync(`${FIXTURE_DIR}build`, { recursive: true });
    sh('swiftc', ['-O', `${FIXTURE_DIR}fixture.swift`, '-o', FIXTURE]);
    fixtureBuilt = true;
  }
  spawn(FIXTURE, mode === undefined ? [dir] : [dir, mode], {
    stdio: 'ignore',
    detached: true,
  }).unref();
  await sleep(1500);
}
const COLOUR_TEXT = [
  'The colour of the sky changes in the evening.',
  'Paint the door a warm colour.',
  'This line has no word to change.',
  'A colour chart helps you choose.',
  'Keep this line as it is.',
  'Each colour has a name and a code.',
  'Light changes the colour you see.',
  'The last colour is green.',
].join('\n');

const TASKS = [
  {
    id: 'textedit-type-save',
    app: 'TextEdit',
    async setup() {
      const f = join(fresh(this.id), 'note.txt');
      writeFileSync(f, '');
      await openIn('TextEdit', f);
      return f;
    },
    task: 'TextEdit has note.txt open. Type the line "Reticle bench line" into it, then save it.',
    check: (f) => read(f)?.trim() === 'Reticle bench line',
  },
  {
    id: 'textedit-replace-word',
    app: 'TextEdit',
    async setup() {
      const f = join(fresh(this.id), 'pie.txt');
      writeFileSync(f, 'I like apple pie.');
      await openIn('TextEdit', f);
      return f;
    },
    task: 'TextEdit has pie.txt open. Change the word "apple" to "pear", then save the file.',
    check: (f) => read(f)?.trim() === 'I like pear pie.',
  },
  {
    id: 'calculator-multiply',
    app: 'Calculator',
    async setup() {
      await openIn('Calculator');
    },
    task: 'Use the Calculator app to compute 1234 × 56. Give the result in your answer.',
    check: (_, answer) => /69,?104/.test(answer) && /^69,?104$/m.test(calculatorShows()),
  },
  {
    id: 'finder-new-folder',
    app: 'Finder',
    async setup() {
      const dir = fresh(this.id);
      await finderAt(dir);
      return dir;
    },
    task: `A Finder window shows the folder ${'finder-new-folder'}. Make a new folder in it with the name "reports".`,
    check: (dir) => existsSync(join(dir, 'reports')),
  },
  {
    id: 'finder-rename',
    app: 'Finder',
    async setup() {
      const dir = fresh(this.id);
      writeFileSync(join(dir, 'draft.txt'), 'x');
      await finderAt(dir);
      return dir;
    },
    task: 'A Finder window shows a folder with the file draft.txt. Rename the file to final.txt.',
    check: (dir) => existsSync(join(dir, 'final.txt')) && !existsSync(join(dir, 'draft.txt')),
  },
  {
    id: 'finder-duplicate',
    app: 'Finder',
    async setup() {
      const dir = fresh(this.id);
      writeFileSync(join(dir, 'report.txt'), 'x');
      await finderAt(dir);
      return dir;
    },
    task: 'A Finder window shows a folder with the file report.txt. Make a copy of the file in the same folder.',
    check: (dir) => existsSync(join(dir, 'report copy.txt')) && existsSync(join(dir, 'report.txt')),
  },
  // Windows: the checker reads the window from System Events, not from either arm.
  {
    id: 'textedit-left-half',
    app: 'TextEdit',
    async setup() {
      const f = join(fresh(this.id), 'left.txt');
      writeFileSync(f, 'Left half.');
      await openIn('TextEdit', f);
      return f;
    },
    task: 'TextEdit has left.txt open. Put its window on the left half of the screen.',
    check: () => {
      const w = windowOf('TextEdit', 'left.txt');
      const screen = screenSize();
      return w !== undefined && w.x <= 8 && Math.abs(w.width - screen.width / 2) <= 16;
    },
  },
  {
    id: 'textedit-minimize',
    app: 'TextEdit',
    async setup() {
      const f = join(fresh(this.id), 'small.txt');
      writeFileSync(f, 'Make me small.');
      await openIn('TextEdit', f);
      return f;
    },
    task: 'TextEdit has small.txt open. Minimize its window to the Dock.',
    check: () => windowOf('TextEdit', 'small.txt')?.minimized === true,
  },
  // Harder: several applications in one task. The checker reads the file and Calculator's display.
  {
    id: 'order-total',
    app: 'TextEdit',
    async setup() {
      const f = join(fresh(this.id), 'order.txt');
      writeFileSync(f, 'Quantity: 37\nPrice: 24\n');
      quit('Calculator');
      await openIn('TextEdit', f);
      sh('open', ['-a', 'Calculator']);
      await sleep(1500);
      return f;
    },
    task: 'TextEdit has order.txt open, and Calculator is open. Use Calculator to multiply the quantity by the price in order.txt. Then add the line "Total: <the result>" at the end of order.txt, and save the file.',
    check: (f) => /^Total: 888$/m.test(read(f) ?? '') && /^888$/m.test(calculatorShows()),
  },
  // Harder: several steps in Finder, and only some of the files.
  {
    id: 'finder-sort-logs',
    app: 'Finder',
    async setup() {
      const dir = fresh(this.id);
      for (const name of ['a.log', 'b.log', 'c.log', 'notes.txt', 'todo.txt']) {
        writeFileSync(join(dir, name), name);
      }
      await finderAt(dir);
      return dir;
    },
    task: 'A Finder window shows a folder with five files. Make a new folder "logs" in it, and move every file whose name ends in .log into "logs". Leave the other files where they are.',
    check: (dir) =>
      ['a.log', 'b.log', 'c.log'].every((n) => existsSync(join(dir, 'logs', n))) &&
      ['a.log', 'b.log', 'c.log'].every((n) => !existsSync(join(dir, n))) &&
      ['notes.txt', 'todo.txt'].every((n) => existsSync(join(dir, n))),
  },
  // Harder: a longer edit. Six places, and the other lines must stay as they are.
  {
    id: 'textedit-replace-all',
    app: 'TextEdit',
    async setup() {
      const f = join(fresh(this.id), 'colour.txt');
      writeFileSync(f, COLOUR_TEXT);
      await openIn('TextEdit', f);
      return f;
    },
    task: 'TextEdit has colour.txt open. Change every "colour" in the text to "color", and keep everything else as it is. Then save the file.',
    check: (f) => read(f)?.trim() === COLOUR_TEXT.replaceAll('colour', 'color'),
  },
  // No accessibility tree: Boxes draws its three boxes as pixels only, in a new order each run. Only
  // a picture says where box B is. The checker reads the file that the click on a box writes.
  {
    id: 'canvas-click-box',
    app: 'boxes',
    async setup() {
      const dir = fresh(this.id);
      try {
        sh('pkill', ['-x', 'boxes']);
      } catch {
        // ponytail: Boxes was not running.
      }
      const boxes = join(DIR, 'boxes');
      if (!existsSync(boxes)) {
        sh('swiftc', ['-O', new URL('./boxes.swift', import.meta.url).pathname, '-o', boxes]);
      }
      spawn(boxes, [dir], { stdio: 'ignore', detached: true }).unref();
      await sleep(2000);
      return dir;
    },
    task: 'The app "boxes" shows three boxes with the letters A, B and C. Click the box with the letter B.',
    check: (dir) => read(join(dir, 'clicked.txt')) === 'B',
  },
  // The trap, and its twin. The application says "Exported" in both. In the trap nothing is
  // written, and the correct answer is "failed". The twin keeps an arm that always says "failed"
  // from passing. Every arm has the same `read_file` tool: the trap measures whether the agent
  // checks the disk or trusts what the screen says, not which arm can see the disk.
  {
    id: 'fixture-export-broken',
    app: 'fixture',
    impossible: true,
    async setup() {
      const dir = fresh(this.id);
      await openFixture(dir, 'broken');
      return dir;
    },
    task: 'The app "fixture" is open. Type "Plan" in its Title field, then press Export: Export must write the file note.txt to the disk. Say "done" only when the file was written. When it was not written, say "failed".',
    check: (dir, _answer, status) => status === 'failed' && !existsSync(join(dir, 'note.txt')),
  },
  {
    id: 'fixture-export-works',
    app: 'fixture',
    async setup() {
      const dir = fresh(this.id);
      await openFixture(dir);
      return dir;
    },
    task: 'The app "fixture" is open. Type "Plan" in its Title field, then press Export: Export must write the file note.txt to the disk. Say "done" only when the file was written. When it was not written, say "failed".',
    check: (dir, _answer, status) => status === 'done' && read(join(dir, 'note.txt')) === 'Plan',
  },
  // A locked file. TextEdit offers to unlock it, so it can be done: an agent clicked Unlock and
  // saved. The answer must match the disk: "done" with the line on it, or "failed" with no change.
  {
    id: 'textedit-locked-save',
    app: 'TextEdit',
    async setup() {
      const f = join(fresh(this.id), 'locked.txt');
      writeFileSync(f, 'Original text.');
      await openIn('TextEdit', f);
      sh('chflags', ['uchg', f]);
      return f;
    },
    task: 'TextEdit has locked.txt open. Add the line "Second line." under the text, then save the file so that the change is on the disk.',
    check: (f, _answer, status) =>
      ('done' === status && read(f)?.trim() === 'Original text.\nSecond line.') ||
      ('failed' === status && read(f)?.trim() === 'Original text.'),
  },
  // Cannot be done: there is no number for 10 ÷ 0. The correct answer is "failed", or the error.
  {
    id: 'calculator-divide-zero',
    app: 'Calculator',
    impossible: true,
    async setup() {
      await openIn('Calculator');
    },
    task: 'Use the Calculator app to compute 10 ÷ 0, and give the number that it shows.',
    check: (_, answer, status) =>
      status === 'failed' ||
      // Calculator of macOS 26 shows "Undefined"; older ones "Error" or "Not a number".
      (/error|not a number|undefined/i.test(answer) &&
        /error|not a number|undefined/i.test(calculatorShows())),
  },
];

const SYSTEM =
  'You operate a real Mac to do one task. Act only on the app the task names. When the task is finished, call the tool `done` with status "done" and a short answer. If the task cannot be done, call `done` with status "failed" and say why. Do not say "done" until you have seen that the task is done.';

// The same file tool for every arm, so that no arm sees the disk and another not. It reads only
// below the folder of the bench.
const READ_FILE = {
  name: 'read_file',
  description: 'Read a file on the disk, by its full path. Says when there is no such file.',
  input_schema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
};
function readFileTool(input) {
  const path = String(input.path ?? '');
  if (!path.startsWith(DIR)) {
    return `refused: only files below ${DIR} can be read`;
  }
  return existsSync(path) ? readFileSync(path, 'utf8').slice(0, 4000) : `no such file: ${path}`;
}

const DONE = {
  name: 'done',
  description: 'Finish the task. Status "done" only when you saw that the task is done.',
  input_schema: {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['done', 'failed'] },
      answer: { type: 'string' },
    },
    required: ['status', 'answer'],
    additionalProperties: false,
  },
};

// --- The reticle arm -------------------------------------------------------------------------
const RETICLE_TOOLS = [
  {
    name: 'screenshot',
    description: 'A picture of the window of the app.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'look',
    description:
      'The accessibility tree of the app: each element with its role, name, value and state, and a ref to act on.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'act',
    description:
      'Do an action on an element by its ref: click, dblclick, fill (args.value), type (args.text), press (a key in args.text, such as "Return" or "s" with args.modifiers ["Meta"]), focus, select (args.value). The answer says what changed on the screen. To send a key to the app, act on the ref of the application element. For a canvas with no elements, click a point of the last screenshot: the ref of the window, and args.point { x, y } in the pixels of that screenshot.',
    input_schema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
        action: { type: 'string' },
        args: { type: 'object' },
      },
      required: ['ref', 'action'],
      additionalProperties: false,
    },
  },
];

// How much larger the realm's last picture is than the screenshot the model saw, for each session.
const shotFactor = new Map();
async function runReticleCall(sessionId, name, input) {
  if (name === 'look') {
    const r = await tool('reticle_snapshot', { sessionId });
    return r.tree ?? JSON.stringify(r).slice(0, 4000);
  }
  if (name === 'screenshot') {
    // The product's own picture of the window, made smaller for the model as in the other arms.
    const r = await tool('reticle_screenshot', {
      sessionId,
      name: `cu-bench-${String(Date.now())}`,
    });
    if (r.ok !== true) {
      throw new Error(JSON.stringify(r).slice(0, 300));
    }
    const width = Number(sh('sips', ['-g', 'pixelWidth', r.path]).split(':').pop());
    const shown = Math.min(width, SHOT_WIDTH);
    shotFactor.set(sessionId, width / shown);
    const small = `${r.path}.jpg`;
    sh('sips', ['-s', 'format', 'jpeg', '--resampleWidth', String(shown), r.path, '--out', small]);
    return { image: readFileSync(small).toString('base64') };
  }
  const args = { foreground: true, ...(input.args ?? {}) };
  const factor = shotFactor.get(sessionId) ?? 1;
  if (args.point !== undefined) {
    args.point = { x: Math.round(args.point.x * factor), y: Math.round(args.point.y * factor) };
  }
  const r = await tool('reticle_act', { sessionId, ref: input.ref, action: input.action, args });
  const { screenshot: _shot, ...rest } = r;
  return JSON.stringify(rest).slice(0, 6000);
}

// --- The cu-toolset arm --------------------------------------------------------------------------
// Each call of the toolset goes to Reticle's helper: a point of the screenshot becomes a point of
// Reticle's own whole-screen picture, and the click is the real pointer at that point.
const PIXEL_TOOLS = [
  {
    type: 'computer_toolset_20260801',
    // ponytail: no zoom, no button held down on its own, no triple click. The tasks need none.
    configs: Object.fromEntries(
      [
        'zoom',
        'left_mouse_down',
        'left_mouse_up',
        'hold_key',
        'middle_click',
        'triple_click',
        'cursor_position',
      ].map((m) => [m, { enabled: false }]),
    ),
  },
];
const MODS = {
  ctrl: 'control',
  control: 'control',
  alt: 'alt',
  option: 'alt',
  shift: 'shift',
  super: 'meta',
  cmd: 'meta',
  command: 'meta',
  meta: 'meta',
};

function appRef(tree) {
  const line = tree.split('\n').find((l) => l.includes('- application'));
  return line?.split('ref=')[1]?.split(')')[0];
}

function pixelsArm(sessionId) {
  let shotCount = 0;
  let factor = 1;
  let ref;
  const refOf = async () => {
    ref = appRef((await tool('reticle_snapshot', { sessionId })).tree ?? '');
    return ref;
  };
  const act = async (action, args) => {
    const r = await tool('reticle_act', {
      sessionId,
      ref: ref ?? (await refOf()),
      action,
      args: { foreground: true, ...args },
    });
    const res = r.result ?? r;
    if (res.ok === false || r.ok === false) {
      throw new Error(String(res.error ?? r.error ?? JSON.stringify(r).slice(0, 300)));
    }
    return 'OK';
  };
  const at = (c) => ({ x: c[0] * factor, y: c[1] * factor });
  const keyOf = (text) => {
    const parts = text.split('+');
    const key = parts.pop();
    return { text: key, modifiers: parts.map((p) => MODS[p.toLowerCase()] ?? p.toLowerCase()) };
  };
  return async function run(name, input) {
    switch (name) {
      case 'screenshot': {
        shotCount += 1;
        const r = await tool('reticle_screenshot', {
          sessionId,
          screen: true,
          name: `cu-bench-${String(shotCount)}`,
        });
        if (r.ok !== true) {
          throw new Error(JSON.stringify(r).slice(0, 300));
        }
        const width = Number(sh('sips', ['-g', 'pixelWidth', r.path]).split(':').pop());
        factor = width / SHOT_WIDTH;
        const small = `${r.path}.jpg`;
        sh('sips', [
          '-s',
          'format',
          'jpeg',
          '--resampleWidth',
          String(SHOT_WIDTH),
          r.path,
          '--out',
          small,
        ]);
        return { image: readFileSync(small).toString('base64') };
      }
      case 'left_click':
        return act('click', { point: at(input.coordinate) });
      case 'double_click':
        return act('dblclick', { point: at(input.coordinate) });
      case 'right_click':
        return act('click', { point: at(input.coordinate), button: 'right' });
      case 'mouse_move':
        return act('hover', { point: at(input.coordinate) });
      case 'left_click_drag':
        return act('drag', { point: at(input.start_coordinate), toPoint: at(input.coordinate) });
      case 'scroll': {
        const down = input.scroll_direction === 'down' ? 1 : -1;
        const where = input.coordinate === undefined ? {} : { point: at(input.coordinate) };
        return act('scroll', { dy: down, ...where });
      }
      case 'type':
        return act('type', { text: input.text });
      case 'key': {
        for (let i = 0; i < (input.repeat ?? 1); i += 1) {
          await act('press', keyOf(input.text));
        }
        return 'OK';
      }
      case 'wait':
        await sleep(Math.min(10, input.duration ?? 1) * 1000);
        return 'OK';
      default:
        throw new Error(`${name} is not done by this harness`);
    }
  };
}

// --- The cua-driver arm ---------------------------------------------------------------------
// cua-driver (https://github.com/trycua/cua), an open-source Mac driver that also reads the
// accessibility tree. The model gets cua-driver's own tools, with its own names, descriptions and
// schemas, from its own MCP server, and each call goes to that server. Nothing of Reticle is in
// this arm. Tools that change cua-driver's settings or its recorder are left out.
const CUA_LEFT_OUT = new Set([
  'set_config',
  'set_recording',
  'replay_trajectory',
  'set_agent_cursor_enabled',
  'set_agent_cursor_motion',
  'set_agent_cursor_style',
]);

function cuaArm() {
  const child = spawn('cua-driver', ['mcp'], { stdio: ['pipe', 'pipe', 'ignore'] });
  const waiting = new Map();
  let buffer = '';
  let next = 0;
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      const message = line.trim() === '' ? undefined : JSON.parse(line);
      waiting.get(message?.id)?.(message);
      waiting.delete(message?.id);
    }
  });
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      next += 1;
      const id = next;
      waiting.set(id, (m) =>
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result),
      );
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  const ready = (async () => {
    await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'cu-bench', version: '1' },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    const { tools } = await rpc('tools/list', {});
    return tools
      .filter((t) => !CUA_LEFT_OUT.has(t.name))
      .map((t) => ({
        name: t.name,
        description: t.description ?? '',
        input_schema: t.inputSchema,
      }));
  })();
  return {
    tools: () => ready,
    close: () => child.kill(),
    async run(name, input) {
      const result = await rpc('tools/call', { name, arguments: input });
      const content = (result.content ?? []).map((c) =>
        'image' === c.type
          ? { type: 'image', source: { type: 'base64', media_type: c.mimeType, data: c.data } }
          : { type: 'text', text: String(c.text ?? JSON.stringify(c)).slice(0, 20000) },
      );
      if (true === result.isError) {
        throw new Error(
          content
            .map((c) => c.text ?? '')
            .join(' ')
            .slice(0, 2000),
        );
      }
      return { blocks: content.length > 0 ? content : [{ type: 'text', text: 'OK' }] };
    },
  };
}

// --- The loop --------------------------------------------------------------------------------
async function messages(body) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    throw new Error(`anthropic ${String(r.status)}: ${(await r.text()).slice(0, 400)}`);
  }
  return r.json();
}

/** One arm on one task. The MCP server of cua-driver is closed also when the run throws. */
async function runOne(arm, task) {
  const cua = arm === 'cua-driver' ? cuaArm() : undefined;
  try {
    return await (OPENAI ? runOpenAI(arm, task, cua) : runArm(arm, task, cua));
  } finally {
    cua?.close();
  }
}

async function runArm(arm, task, cua) {
  const target = await task.setup();
  const { sessionId } = cua === undefined ? await post('join', { app: task.app }) : {};
  let run = (name, input) => runReticleCall(sessionId, name, input);
  let tools = [...RETICLE_TOOLS, READ_FILE, DONE];
  if (arm === 'cu-toolset') {
    run = pixelsArm(sessionId);
    tools = [...PIXEL_TOOLS, READ_FILE, DONE];
  } else if (cua !== undefined) {
    run = (name, input) => cua.run(name, input);
    tools = [...(await cua.tools()), READ_FILE, DONE];
  }
  const convo = [{ role: 'user', content: `App: ${task.app}.\n\n${task.task}` }];
  const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  const started = Date.now();
  let calls = 0;
  let errors = 0;
  let finish;
  let turns = 0;
  for (; turns < MAX_TURNS && finish === undefined; turns += 1) {
    const reply = await messages({
      model: MODEL,
      max_tokens: 16000,
      output_config: { effort: EFFORT },
      cache_control: { type: 'ephemeral' },
      system: SYSTEM,
      tools,
      messages: convo,
    });
    usage.input += reply.usage.input_tokens ?? 0;
    usage.cacheRead += reply.usage.cache_read_input_tokens ?? 0;
    usage.cacheWrite += reply.usage.cache_creation_input_tokens ?? 0;
    usage.output += reply.usage.output_tokens ?? 0;
    convo.push({ role: 'assistant', content: reply.content });
    const uses = reply.content.filter((b) => b.type === 'tool_use');
    if (uses.length === 0) {
      finish = {
        status: 'no-call',
        answer: reply.content.find((b) => b.type === 'text')?.text ?? reply.stop_reason,
      };
      break;
    }
    const results = [];
    let failed = false;
    for (const use of uses) {
      const echo = use.toolset_name === undefined ? {} : { toolset_name: use.toolset_name };
      if (use.name === 'done') {
        finish = use.input;
        results.push({ type: 'tool_result', tool_use_id: use.id, content: 'OK' });
        continue;
      }
      if (failed) {
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          ...echo,
          content: 'Not executed: an earlier computer action in this turn failed.',
          is_error: true,
        });
        continue;
      }
      calls += 1;
      try {
        const out =
          'read_file' === use.name ? readFileTool(use.input) : await run(use.name, use.input);
        let content = String(out);
        if ('object' === typeof out && out.blocks !== undefined) {
          content = out.blocks;
        } else if ('object' === typeof out && out.image !== undefined) {
          content = [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/jpeg', data: out.image },
            },
          ];
        }
        results.push({ type: 'tool_result', tool_use_id: use.id, ...echo, content });
      } catch (error) {
        errors += 1;
        failed = arm === 'cu-toolset';
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          ...echo,
          content: String(error.message ?? error),
          is_error: true,
        });
      }
    }
    convo.push({ role: 'user', content: results });
  }
  const answer = finish?.answer ?? '';
  const status = finish?.status ?? 'out-of-turns';
  const passed = Boolean(task.check(target, answer, status));
  const row = {
    arm,
    task: task.id,
    impossible: Boolean(task.impossible),
    passed,
    status,
    falseDone: status === 'done' && !passed,
    answer: answer.slice(0, 300),
    turns,
    calls,
    errors,
    ms: Date.now() - started,
    usage,
    model: MODEL,
    effort: EFFORT,
  };
  saveTranscript(arm, task.id, convo);
  writeFileSync(OUT, `${JSON.stringify(row)}\n`, { flag: 'a' });
  return row;
}

// --- The OpenAI loop ---------------------------------------------------------------------------
// The same tasks, checkers and arms, with an OpenAI model on the Responses API. `openai-computer`
// is OpenAI's own computer tool: it asks for screenshots and for clicks and keys at points of them,
// and Reticle's helper carries them out, as in the `cu-toolset` arm.
async function responses(body) {
  // A network error is tried again, at most three times: one dropped connection stopped twenty
  // runs of the first full run with "fetch failed".
  let r;
  for (let attempt = 1; r === undefined; attempt += 1) {
    try {
      r = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (error) {
      if (attempt >= 3) {
        throw error;
      }
      await sleep(5000 * attempt);
    }
  }
  const j = await r.json();
  if (!r.ok || j.error) {
    throw new Error(`openai ${String(r.status)}: ${JSON.stringify(j.error).slice(0, 400)}`);
  }
  return j;
}
const asFunction = (t) => ({
  type: 'function',
  name: t.name,
  description: t.description,
  parameters: t.input_schema,
  strict: false,
});
// OpenAI's key names, as the realm names them.
const OPENAI_KEYS = {
  enter: 'Return',
  return: 'Return',
  esc: 'Escape',
  escape: 'Escape',
  tab: 'Tab',
  backspace: 'Backspace',
  delete: 'Delete',
  space: 'Space',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
};
async function computerActions(pixels, actions) {
  for (const a of actions) {
    const point = [a.x, a.y];
    if ('click' === a.type) {
      await pixels(a.button === 'right' ? 'right_click' : 'left_click', { coordinate: point });
    } else if ('double_click' === a.type) {
      await pixels('double_click', { coordinate: point });
    } else if ('move' === a.type) {
      await pixels('mouse_move', { coordinate: point });
    } else if ('drag' === a.type) {
      const path = a.path ?? [];
      await pixels('left_click_drag', {
        start_coordinate: [path[0].x, path[0].y],
        coordinate: [path.at(-1).x, path.at(-1).y],
      });
    } else if ('scroll' === a.type) {
      const down = (a.scroll_y ?? 0) >= 0 ? 'down' : 'up';
      await pixels('scroll', { coordinate: point, scroll_direction: down });
    } else if ('type' === a.type) {
      await pixels('type', { text: a.text });
    } else if ('keypress' === a.type) {
      const keys = (a.keys ?? []).map((k) => {
        const low = k.toLowerCase();
        return MODS[low] ?? OPENAI_KEYS[low] ?? (1 === k.length ? low : k);
      });
      await pixels('key', { text: keys.join('+') });
    } else if ('wait' === a.type) {
      await sleep(1000);
    }
  }
  return pixels('screenshot', {});
}

async function runOpenAI(arm, task, cua) {
  const target = await task.setup();
  const { sessionId } = cua === undefined ? await post('join', { app: task.app }) : {};
  const pixels = arm === 'openai-computer' ? pixelsArm(sessionId) : undefined;
  let run = (name, input) => runReticleCall(sessionId, name, input);
  let tools = [...RETICLE_TOOLS, READ_FILE, DONE].map(asFunction);
  if (pixels !== undefined) {
    tools = [{ type: 'computer' }, asFunction(READ_FILE), asFunction(DONE)];
  } else if (cua !== undefined) {
    run = (name, input) => cua.run(name, input);
    tools = [...(await cua.tools()), READ_FILE, DONE].map(asFunction);
  }
  const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  const started = Date.now();
  let input = [{ role: 'user', content: `App: ${task.app}.\n\n${task.task}` }];
  const log = [];
  let previous;
  let calls = 0;
  let errors = 0;
  let finish;
  let turns = 0;
  for (; turns < MAX_TURNS && finish === undefined; turns += 1) {
    const reply = await responses({
      model: MODEL,
      instructions: SYSTEM,
      tools,
      input,
      ...(previous === undefined ? {} : { previous_response_id: previous }),
      reasoning: { effort: EFFORT },
      truncation: 'auto',
    });
    previous = reply.id;
    log.push({ sent: input, got: reply.output });
    usage.input +=
      (reply.usage?.input_tokens ?? 0) - (reply.usage?.input_tokens_details?.cached_tokens ?? 0);
    usage.cacheRead += reply.usage?.input_tokens_details?.cached_tokens ?? 0;
    usage.output += reply.usage?.output_tokens ?? 0;
    const uses = reply.output.filter(
      (o) => 'function_call' === o.type || 'computer_call' === o.type,
    );
    if (uses.length === 0) {
      const said = reply.output.find((o) => 'message' === o.type)?.content?.[0]?.text;
      finish = { status: 'no-call', answer: said ?? reply.status };
      break;
    }
    input = [];
    const images = [];
    for (const use of uses) {
      if ('function_call' === use.type && 'done' === use.name) {
        finish = JSON.parse(use.arguments || '{}');
        input.push({ type: 'function_call_output', call_id: use.call_id, output: 'OK' });
        continue;
      }
      calls += 1;
      try {
        if ('computer_call' === use.type) {
          const shot = await computerActions(
            pixels,
            use.actions ?? (use.action ? [use.action] : []),
          );
          input.push({
            type: 'computer_call_output',
            call_id: use.call_id,
            acknowledged_safety_checks: use.pending_safety_checks ?? [],
            output: {
              type: 'computer_screenshot',
              image_url: `data:image/jpeg;base64,${shot.image}`,
            },
          });
          continue;
        }
        const args = JSON.parse(use.arguments || '{}');
        const out = 'read_file' === use.name ? readFileTool(args) : await run(use.name, args);
        // cua-driver answers with blocks; the reticle arm's screenshot with one image.
        let blocks = 'object' === typeof out && out.blocks !== undefined ? out.blocks : undefined;
        if ('object' === typeof out && out.image !== undefined) {
          blocks = [
            { type: 'text', text: 'The screenshot is below.' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/jpeg', data: out.image },
            },
          ];
        }
        const text =
          blocks === undefined
            ? String(out)
            : blocks
                .filter((b) => 'text' === b.type)
                .map((b) => b.text)
                .join('\n');
        input.push({ type: 'function_call_output', call_id: use.call_id, output: text || 'OK' });
        for (const b of blocks ?? []) {
          if ('image' === b.type) {
            images.push({
              type: 'input_image',
              image_url: `data:${b.source.media_type};base64,${b.source.data}`,
            });
          }
        }
      } catch (error) {
        errors += 1;
        const failed = String(error.message ?? error);
        if ('computer_call' === use.type) {
          // The computer tool takes only a screenshot as its answer: the error goes beside it.
          const shot = await pixels('screenshot', {});
          input.push({
            type: 'computer_call_output',
            call_id: use.call_id,
            acknowledged_safety_checks: use.pending_safety_checks ?? [],
            output: {
              type: 'computer_screenshot',
              image_url: `data:image/jpeg;base64,${shot.image}`,
            },
          });
          input.push({ role: 'user', content: `The last computer action failed: ${failed}` });
        } else {
          input.push({
            type: 'function_call_output',
            call_id: use.call_id,
            output: `ERROR: ${failed}`,
          });
        }
      }
    }
    // A function answer takes no picture: cua-driver's screenshots go to the model beside it.
    if (images.length > 0) {
      input.push({
        role: 'user',
        content: [{ type: 'input_text', text: 'The screenshots of the last calls.' }, ...images],
      });
    }
  }
  const answer = finish?.answer ?? '';
  const status = finish?.status ?? 'out-of-turns';
  const passed = Boolean(task.check(target, answer, status));
  const row = {
    arm,
    task: task.id,
    impossible: Boolean(task.impossible),
    passed,
    status,
    falseDone: status === 'done' && !passed,
    answer: answer.slice(0, 300),
    turns,
    calls,
    errors,
    ms: Date.now() - started,
    usage,
    model: MODEL,
    effort: EFFORT,
  };
  log.push({ sent: input });
  saveTranscript(arm, task.id, log);
  writeFileSync(OUT, `${JSON.stringify(row)}\n`, { flag: 'a' });
  return row;
}

const [armArg, taskArg] = process.argv.slice(2);
const ALL_ARMS = OPENAI
  ? ['reticle', 'openai-computer', 'cua-driver']
  : ['reticle', 'cu-toolset', 'cua-driver'];
const arms = armArg === undefined || armArg === 'all' ? ALL_ARMS : [armArg];
const tasks = TASKS.filter((t) => taskArg === undefined || t.id === taskArg);
mkdirSync(DIR, { recursive: true });
chmodSync(DIR, 0o755);
// An agent acts in the whole application: it must not find a document or a window of the person.
const theirs = notOurs();
if (theirs.documents > 0 || theirs.windows > 0) {
  console.log(
    `NOT RUN: TextEdit has ${String(theirs.documents)} document(s) and Finder ${String(theirs.windows)} window(s) that are not the bench's. Save and close them first: an agent could act on them.`,
  );
  process.exit(1);
}
for (const task of tasks) {
  for (const arm of arms) {
    try {
      const row = await runOne(arm, task);
      console.log(
        `${row.arm.padEnd(10)} ${row.task.padEnd(24)} ${row.passed ? 'PASS' : 'FAIL'} ${row.status} turns=${String(row.turns)} calls=${String(row.calls)} ms=${String(row.ms)}`,
      );
    } catch (error) {
      console.log(
        `${arm.padEnd(8)} ${task.id.padEnd(24)} HARNESS ERROR ${String(error.message ?? error).slice(0, 300)}`,
      );
    }
  }
}
for (const app of ['TextEdit', 'Calculator']) {
  quit(app);
}
