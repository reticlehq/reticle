/**
 * A recorded upload must replay as recorded.
 *
 * The recorder and the replayer disagreed about what an upload step IS, and the disagreement was
 * total. `reticle_record` writes `{"action":"upload","args":{"path":"test-fixtures/pipe.step"}}` —
 * the only form the live `reticle_act` accepts, and the form that works interactively. Replay sent
 * it straight at the browser, which refused: "upload does not read path, so it would be dropped".
 * So no flow touching a file upload could ever be green, which rules out document ingestion, avatar
 * upload, CSV import — a large slice of what a real app does.
 *
 * The capability was there all along: an agent who hand-patched the flow JSON to
 * `{name, content, type}` got a real upload and a real `POST /files -> 200`.
 */
import { describe, expect, it } from 'vitest';
import { ActionType, AnchorKind, FLOW_FILE_VERSION, type FlowFile } from '@reticlehq/core';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveFlowUploads } from './flow-upload-resolve.js';
import type { FileSystemPort } from '../../project/fs/fs-port.js';

const CWD = resolve(join(tmpdir(), 'reticle-flow-upload-test'));
const RETICLE_ROOT = join(CWD, '.reticle');
const FIXTURE = join(CWD, 'test-fixtures', 'pipe.step');
const BYTES = Buffer.from('ISO-10303-21;\nHEADER;\n');

const fs = {
  stat: (path: string) =>
    path === FIXTURE
      ? Promise.resolve({ size: BYTES.length, isFile: () => true, isDirectory: () => false })
      : Promise.reject(new Error('ENOENT')),
  readFileBytes: (path: string) =>
    path === FIXTURE ? Promise.resolve(BYTES) : Promise.reject(new Error('ENOENT')),
  realpath: (path: string) => Promise.resolve(path),
} as unknown as FileSystemPort;

const deps = { fs, reticleRoot: RETICLE_ROOT };

const flow = (args: Record<string, unknown>, nested = false): FlowFile => {
  const step = {
    tool: 'reticle_act',
    anchor: { kind: AnchorKind.TESTID, value: 'file-input' } as const,
    action: ActionType.UPLOAD,
    args,
  };
  return {
    version: FLOW_FILE_VERSION,
    name: 'import',
    createdAt: 0,
    steps: nested
      ? [
          {
            tool: 'reticle_act_sequence',
            anchor: { kind: AnchorKind.TESTID, value: 'form' } as const,
            steps: [step],
          },
        ]
      : [step],
  };
};

const uploadArgs = (f: FlowFile): Record<string, unknown> => f.steps[0]?.args ?? {};

describe('a recorded upload path becomes bytes before replay', () => {
  it('turns the path the recorder wrote into the shape the browser takes', async () => {
    const out = await resolveFlowUploads(deps, flow({ path: 'test-fixtures/pipe.step' }));
    const args = uploadArgs(out);
    expect(args['name'], 'the browser needs a filename, not a path').toBe('pipe.step');
    expect(args['content'], 'and the real bytes, or the upload is fabricated').toBeDefined();
    expect(
      args['path'],
      'the path must not survive as a second, contradictory source',
    ).toBeUndefined();
  });

  it('resolves an upload nested inside an act_sequence', async () => {
    const out = await resolveFlowUploads(deps, flow({ path: 'test-fixtures/pipe.step' }, true));
    expect(out.steps[0]?.steps?.[0]?.args?.['name']).toBe('pipe.step');
  });

  it('leaves an inline upload alone — it already carries its own bytes', async () => {
    const inline = { name: 'a.txt', content: 'aGk=', type: 'text/plain' };
    const out = await resolveFlowUploads(deps, flow(inline));
    expect(uploadArgs(out)).toEqual(inline);
  });

  it('returns a flow with no upload untouched', async () => {
    const plain: FlowFile = {
      version: FLOW_FILE_VERSION,
      name: 'click',
      createdAt: 0,
      steps: [
        {
          tool: 'reticle_act',
          anchor: { kind: AnchorKind.TESTID, value: 'go' },
          action: ActionType.CLICK,
        },
      ],
    };
    expect(await resolveFlowUploads(deps, plain)).toBe(plain);
  });

  it('fails naming the missing fixture rather than replaying a fabricated file', async () => {
    await expect(
      resolveFlowUploads(deps, flow({ path: 'test-fixtures/gone.step' })),
    ).rejects.toThrow(/gone\.step/);
  });
});
