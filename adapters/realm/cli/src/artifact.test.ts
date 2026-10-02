import { describe, expect, it } from 'vitest';
import { Grade, Independence, couldEverProve } from 'open-verification';
import { CliRealm } from './cli-realm.js';
import { CliChannel } from './channels.js';
import { CliSummary } from './cli-realm.js';
import type { CommandManifest } from './manifest.js';
import type { Invocation, Supervisor } from './process/supervisor.js';
import type { Snapshot, WorkspacePort } from './workspace/port.js';

const invocation: Invocation = {
  id: 'i1',
  command: 'build',
  argv: ['build'],
  startedAt: 0,
  endedAt: 10,
  exit: { code: 0, signal: undefined, wasSignalled: false },
  stdout: [{ seq: 0, text: 'wrote dist/index.js' }],
  stderr: [],
  settledMs: 0,
};

const supervisor: Supervisor = {
  run: () => Promise.resolve(invocation),
  invocationsSince: () => [invocation],
  toolIdentity: () => ({ id: 'mytool', version: '1.0.0', workspace: 'ws' }),
};

const manifest: CommandManifest = {
  workspaceRoot: '/tmp/ws',
  commands: [{ name: 'build', meaning: 'build it', mutating: true, argv: ['build'] }],
};

/** A workspace whose two looks are scripted, so the realm can be driven without a disk. */
function scriptedWorkspace(looks: readonly Snapshot[]): WorkspacePort {
  let next = 0;
  return {
    roots: ['/tmp/ws'],
    excluded: [],
    snapshot: () => looks[Math.min(next++, looks.length - 1)] ?? empty,
  };
}

const empty: Snapshot = { files: new Map(), unreadable: [] };
const withFile = (path: string, hash: string, size = 4): Snapshot => ({
  files: new Map([[path, { hash, size, mode: 0o644, linkTo: undefined }]]),
  unreadable: [],
});

const realm = (workspace: WorkspacePort): CliRealm =>
  new CliRealm({ supervisor, manifest, workspace, now: () => 100 });

describe('the two artifact channels', () => {
  /**
   * The split this realm exists to get right, and the claim the whole adapter rests on.
   *
   * The protocol's test is not "can the subject be wrong about it" but "does the action's own code
   * path decide it" -- which is why pixels stay actuation-derived despite a compositor that can
   * refuse them. Applied honestly to a write, the answer comes out in two halves: the FILESYSTEM
   * decides whether a path exists, and the SUBJECT decides every byte inside it.
   *
   * So existence is independent and consequence-grade, and content is the subject agreeing with
   * itself. Declaring them as one channel at consequence grade would let a `valueContains` over
   * file content buy a `yes`, and clause 9 could not catch it.
   */
  it('grades existence as independent consequence, and content as the subject own word', () => {
    const declared = realm(scriptedWorkspace([empty])).channels();
    const artifact = declared.find((c) => c.id === CliChannel.ARTIFACT);
    expect(artifact?.independence).toBe(Independence.INDEPENDENT);
    expect(artifact?.grade).toBe(Grade.CONSEQUENCE);

    const content = declared.find((c) => c.id === CliChannel.ARTIFACT_CONTENT);
    expect(content?.independence).toBe(Independence.ACTUATION_DERIVED);
    expect(content?.grade).toBe(Grade.PRESENCE);
  });

  /** With the filesystem watched, this realm can finally reach a `yes`. Without it, it cannot. */
  it('can prove something once it watches the filesystem, and not before', () => {
    expect(couldEverProve(realm(scriptedWorkspace([empty])).channels())).toBe(true);
    const blind = new CliRealm({ supervisor, manifest, now: () => 100 });
    expect(couldEverProve(blind.channels())).toBe(false);
    expect(blind.channels().some((c) => c.id === CliChannel.ARTIFACT)).toBe(false);
  });

  it('reports a written path on the independent channel and its bytes on the other', async () => {
    const r = realm(scriptedWorkspace([empty, withFile('/tmp/ws/dist/index.js', 'abc')]));
    const window = r.openWindow(5_000);
    r.closeWindow(window);
    const observed = await r.observe(window);
    const written = observed.find((o) => o.summary === CliSummary.FS_WRITTEN);
    expect(written?.channel).toBe(CliChannel.ARTIFACT);
    const content = observed.find((o) => o.summary === CliSummary.FS_CONTENT);
    expect(content?.channel).toBe(CliChannel.ARTIFACT_CONTENT);
  });

  /**
   * A path that exists and holds nothing is not the consequence anybody asked for.
   *
   * Measured in `bench/cli-false-green`: a build writing a zero-byte `out.txt` was a FALSE GREEN
   * for this adapter and caught by every other checker, because `cli.fs.written` said the same
   * word about an empty file as about a real one — and `summary` is the only part of a match that
   * compares EXACTLY, so no claim over that summary could tell the two apart.
   *
   * A separate summary rather than a size field to read, because a reader of the value is opting
   * in and a matcher on the summary is not: "the build produced out.txt" must not be satisfiable
   * by an empty one BY DEFAULT.
   */
  it('says a different word about an empty write than about a real one', async () => {
    const r = realm(scriptedWorkspace([empty, withFile('/tmp/ws/dist/index.js', 'e3b0c442', 0)]));
    const window = r.openWindow(5_000);
    r.closeWindow(window);
    const observed = await r.observe(window);
    expect(observed.some((o) => o.summary === CliSummary.FS_WRITTEN)).toBe(false);
    const hollow = observed.find((o) => o.summary === CliSummary.FS_WRITTEN_EMPTY);
    expect(hollow?.channel).toBe(CliChannel.ARTIFACT);
    expect((hollow?.value as { size?: number } | undefined)?.size).toBe(0);
  });

  /**
   * The tool said it wrote a file. The filesystem says otherwise, and the filesystem wins.
   *
   * This is the shape the adapter is FOR: stdout is the tool describing itself, and the only thing
   * entitled to contradict it is a party the tool does not control.
   */
  it('records nothing on the artifact channel when the tool wrote nothing it claimed', async () => {
    const r = realm(scriptedWorkspace([empty, empty]));
    const window = r.openWindow(5_000);
    r.closeWindow(window);
    const observed = await r.observe(window);
    expect(observed.some((o) => o.summary === CliSummary.FS_WRITTEN)).toBe(false);
    // And the claim it made is still visible, on the channel that cannot prove it.
    expect(observed.some((o) => o.channel === CliChannel.LOG)).toBe(true);
  });
});

describe('whether the consequence was already true', () => {
  /**
   * The clause no implementation reaches, and the reason a CLI realm can.
   *
   * `already-true` is clause 10. Nothing sets `consequenceHeldBefore` today, because a window opens
   * at the action and the claim only arrives at verification, so there is nothing to evaluate the
   * before-state against. A snapshot realm has the before-state inherently: the first look IS it.
   *
   * Without this, the commonest CLI claim shape -- "dist/index.js exists" -- is already true on
   * every run after the first, and a no-op rebuild proves itself.
   */
  it('reports that a path already existed before the action', () => {
    const already = withFile('/tmp/ws/dist/index.js', 'abc');
    const r = realm(scriptedWorkspace([already, already]));
    const window = r.openWindow(5_000);
    expect(r.existedBefore(window, '/tmp/ws/dist/index.js')).toBe(true);
  });

  it('reports that it did not, when the action is what created it', () => {
    const r = realm(scriptedWorkspace([empty, withFile('/tmp/ws/dist/index.js', 'abc')]));
    const window = r.openWindow(5_000);
    expect(r.existedBefore(window, '/tmp/ws/dist/index.js')).toBe(false);
  });

  /**
   * A realm with no before-state says so, rather than guessing `false`.
   *
   * The protocol reads `undefined` here as NOBODY CHECKED and `false` as "checked, and it did not
   * already hold". Substituting `false` would score better and be a lie.
   */
  it('says nobody checked when there is no workspace to have looked at', () => {
    const blind = new CliRealm({ supervisor, manifest, now: () => 100 });
    const window = blind.openWindow(5_000);
    expect(blind.existedBefore(window, '/tmp/ws/anything')).toBeUndefined();
  });
});
