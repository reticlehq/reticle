import {
  ActionType,
  AnchorKind,
  FLOW_FILE_VERSION,
  FlowStepTool,
  type FlowFile,
} from '@reticlehq/core';
import { describe, expect, it } from 'vitest';
import { RemoteFlowStatus } from './contracts.js';
import { replayFlow, type ReplayLocator, type ReplayPage } from './replay.js';

class FakeLocator implements ReplayLocator {
  calls: string[] = [];
  constructor(
    readonly matches = 1,
    readonly afterAction: (() => void) | undefined = undefined,
  ) {}
  count(): Promise<number> {
    return Promise.resolve(this.matches);
  }
  click(): Promise<void> {
    this.calls.push('click');
    this.afterAction?.();
    return Promise.resolve();
  }
  dblclick(): Promise<void> {
    this.calls.push('dblclick');
    return Promise.resolve();
  }
  hover(): Promise<void> {
    this.calls.push('hover');
    return Promise.resolve();
  }
  focus(): Promise<void> {
    this.calls.push('focus');
    return Promise.resolve();
  }
  blur(): Promise<void> {
    this.calls.push('blur');
    return Promise.resolve();
  }
  fill(value: string): Promise<void> {
    this.calls.push(`fill:${value}`);
    return Promise.resolve();
  }
  press(key: string): Promise<void> {
    this.calls.push(`press:${key}`);
    return Promise.resolve();
  }
  selectOption(value: string): Promise<unknown> {
    this.calls.push(`select:${value}`);
    return Promise.resolve([]);
  }
  check(): Promise<void> {
    this.calls.push('check');
    return Promise.resolve();
  }
  uncheck(): Promise<void> {
    this.calls.push('uncheck');
    return Promise.resolve();
  }
  scrollIntoViewIfNeeded(): Promise<void> {
    this.calls.push('scroll');
    return Promise.resolve();
  }
}

class FakePage implements ReplayPage {
  readonly locators = new Map<string, FakeLocator>();
  navigatedTo = '';
  networkHandler: ((event: { method: string; url: string; status: number }) => void) | undefined;
  consoleHandler: ((event: { level: string }) => void) | undefined;
  goto(url: string): Promise<void> {
    this.navigatedTo = url;
    return Promise.resolve();
  }
  testid(value: string): ReplayLocator {
    return this.locators.get(`testid:${value}`) ?? new FakeLocator(0);
  }
  role(role: string, name?: string): ReplayLocator {
    return this.locators.get(`role:${role}:${name ?? ''}`) ?? new FakeLocator(0);
  }
  observeNetwork(handler: (event: { method: string; url: string; status: number }) => void): void {
    this.networkHandler = handler;
  }
  observeConsole(handler: (event: { level: string }) => void): void {
    this.consoleHandler = handler;
  }
}

function flow(patch: Partial<FlowFile>): FlowFile {
  return {
    version: FLOW_FILE_VERSION,
    name: 'cloud-smoke',
    createdAt: 1,
    steps: [],
    ...patch,
  };
}

describe('Cloudflare flow replay', () => {
  it('drives a semantic role anchor and verifies its DOM consequence', async () => {
    const page = new FakePage();
    const link = new FakeLocator();
    page.locators.set('role:link:More information', link);
    page.locators.set('role:heading:Example Domains', new FakeLocator());
    const result = await replayFlow(
      page,
      'https://example.com/base',
      flow({
        startPath: '/',
        steps: [
          {
            tool: FlowStepTool.ACT,
            anchor: { kind: AnchorKind.ROLE, role: 'link', name: 'More information' },
            action: ActionType.CLICK,
            expect: { element: { role: 'heading', name: 'Example Domains' } },
          },
        ],
      }),
    );

    expect(result).toEqual({ name: 'cloud-smoke', status: RemoteFlowStatus.PASS });
    expect(link.calls).toEqual(['click']);
    expect(page.navigatedTo).toBe('https://example.com/');
  });

  it('verifies a network consequence from only the action window', async () => {
    const page = new FakePage();
    page.locators.set(
      'testid:save',
      new FakeLocator(1, () =>
        page.networkHandler?.({ method: 'POST', url: 'https://app.test/api/save', status: 201 }),
      ),
    );
    const result = await replayFlow(
      page,
      'https://app.test',
      flow({
        steps: [
          {
            tool: FlowStepTool.ACT,
            anchor: { kind: AnchorKind.TESTID, value: 'save' },
            action: ActionType.CLICK,
            expect: { net: { method: 'POST', urlContains: '/api/save', status: 201 } },
          },
        ],
      }),
    );
    expect(result.status).toBe(RemoteFlowStatus.PASS);
  });

  it('refuses an ambiguous anchor instead of guessing', async () => {
    const page = new FakePage();
    page.locators.set('testid:save', new FakeLocator(2));
    const result = await replayFlow(
      page,
      'https://app.test',
      flow({
        steps: [
          {
            tool: FlowStepTool.ACT,
            anchor: { kind: AnchorKind.TESTID, value: 'save' },
            action: ActionType.CLICK,
          },
        ],
      }),
    );
    expect(result.status).toBe(RemoteFlowStatus.FAIL);
    expect(result.detail).toMatch(/exactly one/);
  });

  it('returns unverified for a signal-only expectation the remote page cannot observe', async () => {
    const page = new FakePage();
    page.locators.set('testid:save', new FakeLocator());
    const result = await replayFlow(
      page,
      'https://app.test',
      flow({
        steps: [
          {
            tool: FlowStepTool.ACT,
            anchor: { kind: AnchorKind.TESTID, value: 'save' },
            action: ActionType.CLICK,
            expect: { signal: 'saved' },
          },
        ],
      }),
    );
    expect(result).toEqual({
      name: 'cloud-smoke',
      status: RemoteFlowStatus.UNVERIFIED,
      detail: 'signal expectation',
    });
  });
});
