import { describe, expect, it } from 'vitest';
import { BehaviourFindingKind, type ReticleEvent } from '@reticlehq/core';
import { explore, type ExplorePort } from '../explorer.js';
import { driveEdges, specOf } from './edge-drive.js';

/*
 * A notes app: a title field and a Save that posts it and goes to a page that says what was saved,
 * and a Help dialog with a Cancel. Each option is one defect the plain explorer cannot see: it types
 * one ordinary title and presses Save once.
 */
interface Options {
  /** Save ignores a second press while the first is in flight. */
  guarded?: boolean;
  /** The server answers 500 to a title that is empty or only spaces. */
  faultOnBlank?: boolean;
  /** The saved title is kept only in memory, so a reload loses it. */
  forgetsOnReload?: boolean;
  /** Cancel closes the dialog and leaves a line behind. */
  cancelLeavesTrace?: boolean;
  /** A reload lands on the form again, not on the page that showed the save (no deep links). */
  reloadLosesPlace?: boolean;
}

function notesApp(opts: Options = {}) {
  let page: 'new' | 'done' = 'new';
  let title = '';
  let saved = '';
  let help = false;
  let trace = false;
  let inFlight = false;
  let nextId = 1;
  let refSeq = 0;
  let refs = new Map<string, string>();
  const posts: string[] = [];

  const controls = (): string[] => {
    if ('done' === page) {
      return ['button "New note"'];
    }
    return [
      `textbox "Title"${0 < title.length ? ` [value="${title}"]` : ''}`,
      'button "Save"',
      ...(help ? ['button "Cancel"'] : ['button "Help"']),
    ];
  };
  const text = (): string[] => {
    if ('done' === page) {
      return [`- status "Saved ${saved}"`];
    }
    return [...(help ? ['- dialog "Help"'] : []), ...(trace ? ['- status "Help closed"'] : [])];
  };
  const tree = (): string => {
    refs = new Map();
    return controls()
      .map((desc) => {
        refSeq += 1;
        const ref = `e${String(refSeq)}`;
        refs.set(ref, /^\S+ "[^"]*"/.exec(desc)?.[0] ?? desc);
        return `- ${desc} (ref=${ref})`;
      })
      .join('\n');
  };
  const route = (): string => ('done' === page ? '/done' : '/new');
  const reset = (): void => {
    page = 'new';
    title = '';
    help = false;
    trace = false;
    inFlight = false;
  };

  const port: ExplorePort = {
    reset: () => {
      reset();
      saved = '';
      return Promise.resolve(true);
    },
    look: () => Promise.resolve({ tree: tree(), route: route() }),
    lookFull: () => Promise.resolve({ tree: [tree(), ...text()].join('\n'), route: route() }),
    fieldAttrs: (control) =>
      Promise.resolve('textbox "Title"' === control ? { maxlength: '10', required: '' } : {}),
    reload: () => {
      const keep = page;
      const was = saved;
      reset();
      page = true === opts.reloadLosesPlace ? 'new' : keep;
      saved = true === opts.forgetsOnReload ? '' : was;
      return Promise.resolve(true);
    },
    act: (ref, action, value, actOpts) => {
      const label = refs.get(ref);
      const events: ReticleEvent[] = [];
      if (label === undefined) {
        return Promise.resolve({ ok: false, events });
      }
      if ('fill' === action) {
        title = value ?? '';
      } else if ('button "New note"' === label) {
        page = 'new';
      } else if ('button "Help"' === label) {
        help = true;
      } else if ('button "Cancel"' === label) {
        help = false;
        trace = true === opts.cancelLeavesTrace;
      } else if ('button "Save"' === label) {
        if (inFlight && true === opts.guarded) {
          return Promise.resolve({ ok: true, events });
        }
        const fault = 0 === title.trim().length && true === opts.faultOnBlank;
        const id = nextId;
        nextId += 1;
        posts.push(title);
        events.push({
          type: 'net.request',
          t: 1,
          data: {
            method: 'POST',
            url: 'http://h/api/notes',
            status: fault ? 500 : 201,
            requestBody: JSON.stringify({ title }),
            responseBody: JSON.stringify({ id }),
          },
        } as unknown as ReticleEvent);
        if (!fault) {
          saved = title;
          page = 'done';
        }
        // A press that does not wait leaves its request in flight for the next one.
        inFlight = false === actOpts?.settle;
      }
      return Promise.resolve({ ok: true, events, source: { file: 'src/Notes.tsx', line: 12 } });
    },
  };
  return { port, posts };
}

async function drive(opts: Options, maxActions = 400) {
  const { port, posts } = notesApp(opts);
  const report = await explore(port, { maxActions: 200, fillValue: () => 'hello' });
  const edges = await driveEdges(port, report.surfaces, { maxActions, now: () => 0 });
  return { report, edges, posts, kinds: edges.found.map((f) => f.finding.kind) };
}

describe('explore records what the edge drive needs', () => {
  it('names the fields, their attributes, and the controls that sent a write', async () => {
    const { report } = await drive({});
    const form = report.surfaces.find((s) => 0 < s.fills.length);
    expect(form?.fills.map((f) => f.key)).toEqual(['textbox "Title"']);
    expect(form?.attrs['textbox "Title"']).toEqual({ maxlength: '10', required: '' });
    expect(form?.writes).toEqual(['button "Save"']);
    expect(form?.requests).toEqual(['button "Save"']);
  });
});

describe('driveEdges', () => {
  it('finds a double press that saves twice while the page shows one save', async () => {
    const { edges } = await drive({});
    const repeat = edges.found.find(
      (f) => BehaviourFindingKind.REPEAT_CHANGED_STATE === f.finding.kind,
    );
    expect(repeat?.control).toBe('button "Save"');
    expect(repeat?.finding.sequence).toEqual([
      'fill textbox "Title" with "hello"',
      'click button "Save"',
      'click button "Save"',
    ]);
    expect(repeat?.finding.source).toBe('src/Notes.tsx:12');
  });

  it('passes a Save that ignores the second press', async () => {
    const { kinds } = await drive({ guarded: true });
    expect(kinds).not.toContain(BehaviourFindingKind.REPEAT_CHANGED_STATE);
  });

  it('types edge values into the field and reports the one the server fails on', async () => {
    const { edges, posts } = await drive({ guarded: true, faultOnBlank: true });
    expect(posts).toContain('x'.repeat(11));
    const fault = edges.found.find((f) => 'failed-request' === f.finding.kind);
    expect(fault?.control).toBe('textbox "Title"');
    // The first edge value that faults is the one reported; the same fault again is not news.
    expect(fault?.finding.sequence).toEqual([
      'fill textbox "Title" with ""',
      'click button "Save"',
    ]);
    const onField = edges.found.filter((f) => 'textbox "Title"' === f.control);
    expect(onField).toHaveLength(1);
    // Pressing Save before the title is typed sends the same blank title: a finding on Save.
    const early = edges.found.find((f) => 'button "Save"' === f.control);
    expect(early?.finding.sequence).toEqual([
      'click button "Save"',
      'fill textbox "Title" with "hello"',
      'click button "Save"',
    ]);
    expect(edges.probed).toContain('textbox "Title"');
  });

  it('reports a saved value a reload loses, and passes one it keeps', async () => {
    const lost = await drive({ guarded: true, forgetsOnReload: true });
    expect(lost.kinds).toContain(BehaviourFindingKind.LOST_AFTER_RELOAD);
    const kept = await drive({ guarded: true });
    expect(kept.kinds).not.toContain(BehaviourFindingKind.LOST_AFTER_RELOAD);
  });

  /*
   * Found on bench-app's clean build: the app has no deep links, so a reload of the saved list lands
   * on another view. The saved value is still on the server; the reload only lost the user's place,
   * and the page it reached cannot show the value, so nothing can be judged there.
   */
  it('does not judge a reload that lands on another view', async () => {
    const elsewhere = await drive({ guarded: true, forgetsOnReload: true, reloadLosesPlace: true });
    expect(elsewhere.kinds).not.toContain(BehaviourFindingKind.LOST_AFTER_RELOAD);
  });

  it('reports a Cancel that does not restore the page, and passes one that does', async () => {
    const broken = await drive({ guarded: true, cancelLeavesTrace: true });
    const undo = broken.edges.found.find(
      (f) => BehaviourFindingKind.UNDO_NOT_RESTORED === f.finding.kind,
    );
    expect(undo?.control).toBe('button "Cancel"');
    expect(undo?.finding.detail).toContain('Help closed');
    const clean = await drive({ guarded: true });
    expect(clean.kinds).not.toContain(BehaviourFindingKind.UNDO_NOT_RESTORED);
  });

  it('a clean app gives no findings', async () => {
    const { edges } = await drive({ guarded: true });
    expect(edges.found).toEqual([]);
    expect(edges.probed).toEqual(
      expect.arrayContaining(['button "Save"', 'textbox "Title"', 'button "Cancel"']),
    );
  });

  it('keeps to its budget, and spends it on the control that writes first', async () => {
    const { edges } = await drive({}, 8);
    expect(edges.actions).toBeLessThanOrEqual(8);
    expect(edges.budgetExhausted).toBe(true);
    expect(edges.probed).toEqual(['button "Save"']);
  });

  it('gives the same probes in the same order on the same app', async () => {
    const first = await drive({ faultOnBlank: true });
    const second = await drive({ faultOnBlank: true });
    expect(second.edges.found).toEqual(first.edges.found);
    expect(second.posts).toEqual(first.posts);
  });
});

describe('specOf', () => {
  it('reads the field attributes edgeInputs uses', () => {
    expect(
      specOf('spinbutton "Quantity"', { type: 'number', min: '1', max: '9', required: '' }),
    ).toEqual({
      role: 'spinbutton',
      name: 'Quantity',
      type: 'number',
      min: '1',
      max: '9',
      required: true,
    });
  });
});

/*
 * The login form of a real app, as the snapshot shows it: both fields pre-filled, the password
 * redacted. The explorer leaves a field that holds a value alone, so it types nothing here, and the
 * edge-value round once took its fields from what the explorer typed. It never filled either field.
 */
function prefilledLogin() {
  let email = 'admin@x.dev';
  let password = 'secret';
  let refs = new Map<string, string>();
  let seq = 0;
  const sent: { email: string; password: string }[] = [];
  const port: ExplorePort = {
    reset: () => {
      email = 'admin@x.dev';
      password = 'secret';
      return Promise.resolve(true);
    },
    look: () => {
      refs = new Map();
      const line = (label: string, extra = ''): string => {
        seq += 1;
        refs.set(`e${String(seq)}`, label);
        return `- ${label} (ref=e${String(seq)})${extra}`;
      };
      const tree = [
        line('textbox "Email"', email.length > 0 ? ` [value="${email}"]` : ''),
        line('textbox "Password"', password.length > 0 ? ' [value="[REDACTED]"]' : ''),
        line('button "Sign in"'),
      ].join('\n');
      return Promise.resolve({ tree, route: '/' });
    },
    fieldAttrs: (control) =>
      Promise.resolve('textbox "Password"' === control ? { type: 'password' } : {}),
    act: (ref, action, value) => {
      const label = refs.get(ref);
      const events: ReticleEvent[] = [];
      if ('fill' === action && 'textbox "Email"' === label) {
        email = value ?? '';
      } else if ('fill' === action && 'textbox "Password"' === label) {
        password = value ?? '';
      } else if ('button "Sign in"' === label) {
        sent.push({ email, password });
        const good = 'admin@x.dev' === email && 'secret' === password;
        events.push({
          type: 'net.request',
          t: 1,
          data: { method: 'POST', url: 'http://h/api/login', status: good ? 200 : 401 },
        } as unknown as ReticleEvent);
      }
      return Promise.resolve({ ok: label !== undefined, events });
    },
  };
  return { port, sent };
}

describe('driveEdges on a form whose fields are pre-filled', () => {
  it('types edge values into each pre-filled field and submits them', async () => {
    const { port, sent } = prefilledLogin();
    const report = await explore(port, { maxActions: 50, fillValue: () => 'typed' });
    const form = report.surfaces[0];
    expect(form?.fills).toEqual([]);
    expect(form?.fields).toEqual(['textbox "Email"', 'textbox "Password"']);
    expect(form?.attrs['textbox "Password"']).toEqual({ type: 'password' });
    const edges = await driveEdges(port, report.surfaces, { maxActions: 200, now: () => 0 });
    expect(edges.probed).toEqual(expect.arrayContaining(['textbox "Email"', 'textbox "Password"']));
    expect(sent).toContainEqual({ email: '', password: 'secret' });
    expect(sent).toContainEqual({ email: 'admin@x.dev', password: '   ' });
  });
});

/* Two writes on one page, and a Help button that may do nothing. */
function twoWrites(opts: { helpWakesLate?: boolean } = {}) {
  let refs = new Map<string, string>();
  let seq = 0;
  // The explorer pressed Help once already; the edge drive's press is the second.
  let helpPresses = 1;
  const port: ExplorePort = {
    reset: () => Promise.resolve(true),
    look: () => {
      refs = new Map();
      const tree = ['button "Save draft"', 'button "Save copy"', 'button "Help"']
        .map((c) => {
          seq += 1;
          refs.set(`e${String(seq)}`, c);
          return `- ${c} (ref=e${String(seq)})`;
        })
        .join('\n');
      return Promise.resolve({ tree, route: '/' });
    },
    act: (ref) => {
      const label = refs.get(ref) ?? '';
      const events: ReticleEvent[] = [];
      if (label.startsWith('button "Save')) {
        events.push({
          type: 'net.request',
          t: 1,
          data: { method: 'POST', url: `http://h/api/${label.length}`, status: 200 },
        } as unknown as ReticleEvent);
      } else if ('button "Help"' === label) {
        helpPresses += 1;
        if (true === opts.helpWakesLate && helpPresses > 1) {
          events.push({ type: 'dom.added', t: 1, data: {} } as unknown as ReticleEvent);
        }
      }
      return Promise.resolve({ ok: true, events });
    },
  };
  const surface = {
    path: [],
    fills: [],
    fields: [],
    attrs: {},
    order: ['button "Save draft"', 'button "Save copy"', 'button "Help"'],
    requests: ['button "Save draft"', 'button "Save copy"'],
    writes: ['button "Save draft"', 'button "Save copy"'],
    inert: ['button "Help"'],
  };
  return { port, surface };
}

describe('driveEdges — every write first, and dead controls confirmed', () => {
  it('probes every control that writes once before any of them twice', async () => {
    const { port, surface } = twoWrites();
    const edges = await driveEdges(port, [surface], { maxActions: 6, now: () => 0 });
    expect(edges.probed).toEqual(['button "Save draft"', 'button "Save copy"']);
  });

  it('reports a control that did nothing on a second press too', async () => {
    const { port, surface } = twoWrites();
    const edges = await driveEdges(port, [surface], { maxActions: 200, now: () => 0 });
    const dead = edges.found.find((f) => 'dead-control' === f.finding.kind);
    expect(dead?.control).toBe('button "Help"');
  });

  it('does not report one that answered the second time', async () => {
    const { port, surface } = twoWrites({ helpWakesLate: true });
    const edges = await driveEdges(port, [surface], { maxActions: 200, now: () => 0 });
    expect(edges.found.map((f) => f.finding.kind)).not.toContain('dead-control');
  });
});
