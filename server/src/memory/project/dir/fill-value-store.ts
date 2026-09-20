/**
 * The values a drive types into this project's fields, kept so they are paid for once.
 *
 * A generated field value is not a model's opinion to be re-asked every run. It is a FIXTURE: the
 * same label on the same app wants the same value tomorrow, a replay must send exactly what the
 * recording sent or it is not a replay, and a human who dislikes "Acme Corp" should be able to open
 * a file and write something else rather than argue with a model about it. So it lives beside the
 * flows it belongs to, in git, in the project's own directory.
 *
 * Read once at the start of a drive and written once at the end: a drive that fills twenty fields
 * must not write the file twenty times, and nothing else in the process is competing for it.
 *
 * Every failure is silent and answers "no values". A drive must never fail over a fixtures file,
 * and the fallback -- the label heuristic -- is what every drive used before this existed.
 */

import { ReticleDir } from '@reticlehq/core';
import { join } from 'node:path';
import type { FileSystemPort } from '@/memory/project/fs/fs-port.js';

/** Stamped so a later format change can tell an old file from a broken one. */
const VERSION = 1;

interface FillValuesFile {
  version: number;
  /** Field label -> what to type into it. */
  values: Record<string, string>;
}

/** A label is a UI string and can be anything; a value that is not a string is not usable. */
function parse(text: string): Record<string, string> {
  try {
    const raw: unknown = JSON.parse(text);
    if ('object' !== typeof raw || null === raw) return {};
    const values = (raw as Partial<FillValuesFile>).values;
    if ('object' !== typeof values || null === values) return {};
    const out: Record<string, string> = {};
    for (const [label, value] of Object.entries(values))
      if ('string' === typeof value && 0 < value.length) out[label] = value;
    return out;
  } catch {
    return {};
  }
}

/** What a drive holds while it runs: a read-through map plus whatever it learned. */
export interface FillValueStore {
  get(label: string): string | undefined;
  set(label: string, value: string): void;
  /** Persist, if anything was learned. Silent on failure, like every read here. */
  flush(): Promise<void>;
}

/**
 * A store that remembers within one drive and writes nothing.
 *
 * Used when there is no project directory to write to. A drive must never fail over its fixtures
 * file, and that includes failing to FIND one: the values still de-duplicate inside the run, they
 * are simply not carried into the next one.
 */
export function memoryFillValues(): FillValueStore {
  const values = new Map<string, string>();
  return {
    get: (label) => values.get(label),
    set: (label, value) => void values.set(label, value),
    flush: () => Promise.resolve(),
  };
}

export async function openFillValues(
  fs: FileSystemPort,
  root: string | undefined,
): Promise<FillValueStore> {
  if (root === undefined || 0 === root.length) return memoryFillValues();
  const path = join(root, ReticleDir.FILL_VALUES_FILE);
  let values: Record<string, string> = {};
  try {
    if (await fs.exists(path)) values = parse(await fs.readFile(path));
  } catch {
    /* an unreadable fixtures file is the same as an absent one */
  }
  let learned = false;

  return {
    get: (label) => values[label],
    set: (label, value) => {
      if (values[label] === value) return;
      values[label] = value;
      learned = true;
    },
    async flush(): Promise<void> {
      if (!learned) return;
      try {
        await fs.mkdir(root);
        const file: FillValuesFile = { version: VERSION, values };
        await fs.writeFile(path, `${JSON.stringify(file, null, 2)}\n`);
      } catch {
        /* the drive already happened; losing the cache costs a regeneration, not a result */
      }
    },
  };
}
