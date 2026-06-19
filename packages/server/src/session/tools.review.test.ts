import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import {
  EventType,
  IRIS_PROTOCOL_VERSION,
  MarkAnchorStrategy,
  MessageKind,
  type HelloMessage,
  type HumanMarkData,
  type IrisEvent,
} from '@syrin/iris-protocol';
import { Session, type SessionManager } from './session.js';
import { LIVE_CONTROL_TOOLS } from './live-control-tools.js';
import { IrisTool } from '../tools/tool-names.js';
import type { ToolDeps } from '../tools/tools.js';

const HELLO: HelloMessage = {
  kind: MessageKind.HELLO,
  protocolVersion: IRIS_PROTOCOL_VERSION,
  sessionId: 'demo',
  url: 'http://localhost/checkout',
  title: 'Demo',
  adapters: [],
  hasCapabilities: false,
};

const fakeSocket = { send: (): void => {} } as unknown as WebSocket;

function markEvent(data: Partial<HumanMarkData> = {}): IrisEvent {
  const mark: HumanMarkData = {
    note: 'Submit button is misaligned',
    anchor: 'component:Submit@src/Checkout.tsx:42',
    strategy: MarkAnchorStrategy.COMPONENT,
    label: 'Submit button',
    source: { file: 'src/Checkout.tsx', line: 42 },
    route: '/checkout',
    ...data,
  };
  return { type: EventType.HUMAN_MARK, data: mark } as unknown as IrisEvent;
}

function depsFor(session: Session): ToolDeps {
  const sessions: Partial<SessionManager> = { resolve: () => session };
  return { sessions: sessions as SessionManager } as unknown as ToolDeps;
}

function reviewTool() {
  const t = LIVE_CONTROL_TOOLS.find((x) => x.name === IrisTool.REVIEW);
  if (t === undefined) throw new Error('no iris_review tool');
  return t;
}

interface ReviewShape {
  marks: { id: string; note: string; fix: string; source?: { file: string; line: number } }[];
  pendingCount: number;
  resolved?: boolean;
}

describe('iris_review tool — human marks ingested from HUMAN_MARK events', () => {
  it('lists a pinned mark with a source-aware fix hint, then resolves it', async () => {
    const session = new Session(HELLO, fakeSocket, () => 0);
    session.pushEvent(markEvent());

    const listed = (await reviewTool().handler(depsFor(session), {})) as ReviewShape;
    expect(listed.pendingCount).toBe(1);
    expect(listed.marks).toHaveLength(1);
    const mark = listed.marks[0];
    expect(mark?.note).toBe('Submit button is misaligned');
    expect(mark?.source).toEqual({ file: 'src/Checkout.tsx', line: 42 });
    expect(mark?.fix).toContain('src/Checkout.tsx:42');
    expect(mark?.fix).toContain('iris_review { resolve:');

    const resolved = (await reviewTool().handler(depsFor(session), {
      resolve: mark?.id,
    })) as ReviewShape;
    expect(resolved.resolved).toBe(true);
    expect(resolved.pendingCount).toBe(0);
    expect(resolved.marks).toHaveLength(0);
  });

  it('falls back to the element label in the fix hint when no source was stamped', async () => {
    const session = new Session(HELLO, fakeSocket, () => 0);
    session.pushEvent(
      markEvent({ source: undefined, label: 'Buy now CTA', anchor: 'role:button:Buy now' }),
    );
    const listed = (await reviewTool().handler(depsFor(session), {})) as ReviewShape;
    expect(listed.marks[0]?.fix).toContain('"Buy now CTA"');
  });

  it('ignores a malformed mark (empty note) — the boundary narrows it away', async () => {
    const session = new Session(HELLO, fakeSocket, () => 0);
    session.pushEvent(markEvent({ note: '' }));
    const listed = (await reviewTool().handler(depsFor(session), {})) as ReviewShape;
    expect(listed.pendingCount).toBe(0);
  });

  it('surfaces pending marks in session.info() only when > 0 (zero adds nothing to the payload)', () => {
    const session = new Session(HELLO, fakeSocket, () => 0);
    expect('pendingMarks' in session.info()).toBe(false);
    expect('review_suggestion' in session.info()).toBe(false);

    session.pushEvent(markEvent());
    session.pushEvent(markEvent({ note: 'second issue' }));
    const info = session.info();
    expect(info.pendingMarks).toBe(2);
    expect(info.review_suggestion).toMatch(/flagged 2 issues/);
    expect(info.review_suggestion).toMatch(/iris_review/);

    // Resolving a mark drops the count; resolving all removes the fields again.
    const pending = session.pendingMarks();
    session.resolveMark(pending[0]?.id ?? '');
    session.resolveMark(pending[1]?.id ?? '');
    expect('pendingMarks' in session.info()).toBe(false);
  });

  it('all:true includes resolved marks in history', async () => {
    const session = new Session(HELLO, fakeSocket, () => 0);
    session.pushEvent(markEvent());
    const first = (await reviewTool().handler(depsFor(session), {})) as ReviewShape;
    await reviewTool().handler(depsFor(session), { resolve: first.marks[0]?.id });
    const all = (await reviewTool().handler(depsFor(session), { all: true })) as ReviewShape;
    expect(all.marks).toHaveLength(1);
    expect(all.pendingCount).toBe(0);
  });
});
