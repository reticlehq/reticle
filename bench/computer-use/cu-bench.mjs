// Computer-use benchmark: Reticle's tree-and-ref tools against Claude's own computer-use toolset.
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
// It needs the operator from the computer-use run (a bridge, and HTTP on 4499 that joins an app
// and runs a tool), the screen for itself, and ANTHROPIC_API_KEY.
//
//   node --env-file=../../.env bench/computer-use/cu-bench.mjs [arm] [taskId]
//
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.BENCH_MODEL ?? 'claude-opus-5-5';
const EFFORT = process.env.BENCH_EFFORT ?? 'medium';
const MAX_TURNS = Number(process.env.BENCH_MAX_TURNS ?? 30);
const OPERATOR = 'http://127.0.0.1:4499';
const DIR = '/tmp/reticle-cu-bench';
const SHOT_WIDTH = 1280;
const OUT = new URL('./results.jsonl', import.meta.url);

if (!KEY) {
  console.log('NOT MEASURED: ANTHROPIC_API_KEY is not set.');
  process.exit(0);
}

const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' });
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const quit = (app) => {
  try {
    sh('osascript', ['-e', `tell application "${app}" to quit saving no`]);
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
  sh('osascript', ['-e', 'tell application "Finder" to close every window']);
  sh('open', [dir]);
  await sleep(2000);
}

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
    check: (_, answer) => /69,?104/.test(answer),
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
  // Cannot be done: the file is locked, so the save does not happen. The correct answer is "failed".
  {
    id: 'textedit-locked-save',
    app: 'TextEdit',
    impossible: true,
    async setup() {
      const f = join(fresh(this.id), 'locked.txt');
      writeFileSync(f, 'Original text.');
      await openIn('TextEdit', f);
      sh('chflags', ['uchg', f]);
      return f;
    },
    task: 'TextEdit has locked.txt open. Add the line "Second line." under the text, then save the file so that the change is on the disk.',
    check: (f, _answer, status) => status === 'failed' && read(f)?.trim() === 'Original text.',
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
    check: (_, answer, status) => status === 'failed' || /error|not a number/i.test(answer),
  },
];

const SYSTEM =
  'You operate a real Mac to do one task. Act only on the app the task names. When the task is finished, call the tool `done` with status "done" and a short answer. If the task cannot be done, call `done` with status "failed" and say why. Do not say "done" until you have seen that the task is done.';

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
    name: 'look',
    description:
      'The accessibility tree of the app: each element with its role, name, value and state, and a ref to act on.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'act',
    description:
      'Do an action on an element by its ref: click, dblclick, fill (args.value), type (args.text), press (a key in args.text, such as "Return" or "s" with args.modifiers ["Meta"]), focus, select (args.value). The answer says what changed on the screen. To send a key to the app, act on the ref of the application element.',
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

async function runReticleCall(sessionId, name, input) {
  if (name === 'look') {
    const r = await tool('reticle_snapshot', { sessionId });
    return r.tree ?? JSON.stringify(r).slice(0, 4000);
  }
  const args = { foreground: true, ...(input.args ?? {}) };
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

async function runOne(arm, task) {
  const target = await task.setup();
  const { sessionId } = await post('join', { app: task.app });
  const run =
    arm === 'cu-toolset'
      ? pixelsArm(sessionId)
      : (name, input) => runReticleCall(sessionId, name, input);
  const tools = arm === 'cu-toolset' ? [...PIXEL_TOOLS, DONE] : [...RETICLE_TOOLS, DONE];
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
        const out = await run(use.name, use.input);
        const content =
          'object' === typeof out && out.image !== undefined
            ? [
                {
                  type: 'image',
                  source: { type: 'base64', media_type: 'image/jpeg', data: out.image },
                },
              ]
            : String(out);
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
  writeFileSync(OUT, `${JSON.stringify(row)}\n`, { flag: 'a' });
  return row;
}

const [armArg, taskArg] = process.argv.slice(2);
const arms = armArg === undefined || armArg === 'all' ? ['reticle', 'cu-toolset'] : [armArg];
const tasks = TASKS.filter((t) => taskArg === undefined || t.id === taskArg);
mkdirSync(DIR, { recursive: true });
chmodSync(DIR, 0o755);
for (const task of tasks) {
  for (const arm of arms) {
    try {
      const row = await runOne(arm, task);
      console.log(
        `${row.arm.padEnd(8)} ${row.task.padEnd(24)} ${row.passed ? 'PASS' : 'FAIL'} ${row.status} turns=${String(row.turns)} calls=${String(row.calls)} ms=${String(row.ms)}`,
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
