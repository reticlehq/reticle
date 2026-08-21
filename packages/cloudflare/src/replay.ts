import {
  ActionType,
  AnchorKind,
  FlowStepTool,
  type FlowExpect,
  type FlowFile,
  type FlowStep,
} from '@reticlehq/core';
import type { Locator, Page } from '@cloudflare/playwright';
import { RemoteFlowStatus, type RemoteFlowResult } from './contracts.js';

interface NetworkObservation {
  method: string;
  url: string;
  status: number;
}

interface ConsoleObservation {
  level: string;
}

export interface ReplayLocator {
  count(): Promise<number>;
  click(): Promise<void>;
  dblclick(): Promise<void>;
  hover(): Promise<void>;
  focus(): Promise<void>;
  blur(): Promise<void>;
  fill(value: string): Promise<void>;
  press(key: string): Promise<void>;
  selectOption(value: string): Promise<unknown>;
  check(): Promise<void>;
  uncheck(): Promise<void>;
  scrollIntoViewIfNeeded(): Promise<void>;
}

export interface ReplayPage {
  goto(url: string): Promise<void>;
  testid(value: string): ReplayLocator;
  role(role: string, name?: string): ReplayLocator;
  observeNetwork(handler: (event: NetworkObservation) => void): void;
  observeConsole(handler: (event: ConsoleObservation) => void): void;
}

function locatorAdapter(locator: Locator): ReplayLocator {
  return {
    count: () => locator.count(),
    click: () => locator.click(),
    dblclick: () => locator.dblclick(),
    hover: () => locator.hover(),
    focus: () => locator.focus(),
    blur: () => locator.blur(),
    fill: (value) => locator.fill(value),
    press: (key) => locator.press(key),
    selectOption: (value) => locator.selectOption(value),
    check: () => locator.check(),
    uncheck: () => locator.uncheck(),
    scrollIntoViewIfNeeded: () => locator.scrollIntoViewIfNeeded(),
  };
}

/** Keep Cloudflare Playwright types at this adapter; the replay engine stays fake-driven in tests. */
export function pageAdapter(page: Page): ReplayPage {
  return {
    goto: async (url) => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    },
    testid: (value) => locatorAdapter(page.getByTestId(value)),
    role: (role, name) =>
      locatorAdapter(
        page.getByRole(
          role as Parameters<Page['getByRole']>[0],
          name === undefined ? undefined : { name },
        ),
      ),
    observeNetwork: (handler) => {
      page.on('response', (response) => {
        handler({
          method: response.request().method(),
          url: response.url(),
          status: response.status(),
        });
      });
    },
    observeConsole: (handler) => {
      page.on('console', (message) => handler({ level: message.type() }));
      page.on('pageerror', () => handler({ level: 'error' }));
    },
  };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function resolveLocator(page: ReplayPage, step: FlowStep): ReplayLocator | null {
  if (AnchorKind.TESTID === step.anchor.kind) return page.testid(step.anchor.value);
  if (AnchorKind.ROLE === step.anchor.kind) {
    return page.role(step.anchor.role, step.anchor.name);
  }
  return null;
}

function argument(
  args: Record<string, unknown> | undefined,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const value = args?.[name];
    if ('string' === typeof value) return value;
  }
  return undefined;
}

async function act(locator: ReplayLocator, step: FlowStep): Promise<string | null> {
  switch (step.action) {
    case ActionType.CLICK:
      await locator.click();
      return null;
    case ActionType.DBLCLICK:
      await locator.dblclick();
      return null;
    case ActionType.HOVER:
      await locator.hover();
      return null;
    case ActionType.FOCUS:
      await locator.focus();
      return null;
    case ActionType.BLUR:
      await locator.blur();
      return null;
    case ActionType.FILL:
    case ActionType.TYPE: {
      const value = argument(step.args, 'value', 'text');
      if (value === undefined) return `${step.action} requires a string value`;
      await locator.fill(value);
      return null;
    }
    case ActionType.CLEAR:
      await locator.fill('');
      return null;
    case ActionType.SELECT: {
      const value = argument(step.args, 'value');
      if (value === undefined) return 'select requires a string value';
      await locator.selectOption(value);
      return null;
    }
    case ActionType.CHECK:
      await locator.check();
      return null;
    case ActionType.UNCHECK:
      await locator.uncheck();
      return null;
    case ActionType.PRESS: {
      const key = argument(step.args, 'key', 'text');
      if (key === undefined) return 'press requires a key';
      await locator.press(key);
      return null;
    }
    case ActionType.SCROLL_INTO_VIEW:
      await locator.scrollIntoViewIfNeeded();
      return null;
    case undefined:
      return null;
    default:
      return `remote runner does not support action ${step.action}`;
  }
}

function expectationLocator(
  page: ReplayPage,
  expect: NonNullable<FlowExpect['element']>,
): ReplayLocator | null {
  if (expect.testid !== undefined) return page.testid(expect.testid);
  if (expect.role !== undefined) return page.role(expect.role, expect.name);
  return null;
}

async function eventually(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (await check()) return true;
    await sleep(100);
  } while (Date.now() < deadline);
  return false;
}

async function checkExpectation(
  page: ReplayPage,
  expect: FlowExpect,
  network: NetworkObservation[],
  consoleEvents: ConsoleObservation[],
): Promise<{ passed: boolean; unsupported?: string; failure?: string }> {
  let unsupported: string | undefined;
  if (expect.signal !== undefined || expect.signalData !== undefined)
    unsupported = 'signal expectation';
  if (expect.state !== undefined) unsupported = 'state expectation';

  if (expect.element !== undefined) {
    const locator = expectationLocator(page, expect.element);
    if (null === locator)
      return { passed: false, failure: 'element expectation has no testid or role' };
    if (!(await eventually(async () => 1 === (await locator.count())))) {
      return { passed: false, failure: 'expected element did not resolve exactly once' };
    }
  }

  if (expect.net !== undefined) {
    const matches = (): NetworkObservation[] =>
      network.filter(
        (event) =>
          (expect.net?.method === undefined || event.method === expect.net.method) &&
          (expect.net?.urlContains === undefined || event.url.includes(expect.net.urlContains)) &&
          (expect.net?.status === undefined || event.status === expect.net.status),
      );
    const found = await eventually(() => {
      const count = matches().length;
      return expect.net?.count === undefined ? count > 0 : count === expect.net.count;
    });
    if (!found) return { passed: false, failure: 'network expectation did not hold' };
  }

  if (expect.console !== undefined) {
    await sleep(250);
    const level = expect.console.level ?? 'error';
    const found = consoleEvents.some((event) => event.level === level);
    const passed = true === expect.console.absent ? !found : found;
    if (!passed) return { passed: false, failure: 'console expectation did not hold' };
  }

  return {
    passed: true,
    ...(unsupported === undefined ? {} : { unsupported }),
  };
}

interface ReplayProgress {
  asserted: boolean;
  unsupported?: string;
}

async function replayStep(
  page: ReplayPage,
  step: FlowStep,
  network: NetworkObservation[],
  consoleEvents: ConsoleObservation[],
  progress: ReplayProgress,
): Promise<string | null> {
  if (FlowStepTool.ACT_SEQUENCE === step.tool) {
    for (const child of step.steps ?? []) {
      const error = await replayStep(page, child, network, consoleEvents, progress);
      if (error !== null) return error;
    }
    return null;
  }
  const locator = resolveLocator(page, step);
  if (null === locator) {
    progress.unsupported = `${step.anchor.kind} anchor requires the in-page Reticle bridge`;
    return null;
  }
  const count = await locator.count();
  if (1 !== count) return `anchor resolved ${String(count)} elements; expected exactly one`;
  const networkStart = network.length;
  const consoleStart = consoleEvents.length;
  const actionError = await act(locator, step);
  if (actionError !== null) {
    progress.unsupported = actionError;
    return null;
  }
  if (step.expect === undefined) return null;
  progress.asserted = true;
  const checked = await checkExpectation(
    page,
    step.expect,
    network.slice(networkStart),
    consoleEvents.slice(consoleStart),
  );
  if (!checked.passed) return checked.failure ?? 'expectation failed';
  if (checked.unsupported !== undefined) progress.unsupported = checked.unsupported;
  return null;
}

export async function replayFlow(
  page: ReplayPage,
  previewUrl: string,
  flow: FlowFile,
): Promise<RemoteFlowResult> {
  const network: NetworkObservation[] = [];
  const consoleEvents: ConsoleObservation[] = [];
  page.observeNetwork((event) => network.push(event));
  page.observeConsole((event) => consoleEvents.push(event));
  const startUrl =
    flow.startPath === undefined ? previewUrl : new URL(flow.startPath, previewUrl).href;
  await page.goto(startUrl);
  const progress: ReplayProgress = { asserted: false };
  for (const step of flow.steps) {
    const failure = await replayStep(page, step, network, consoleEvents, progress);
    if (failure !== null)
      return { name: flow.name, status: RemoteFlowStatus.FAIL, detail: failure };
  }
  if (flow.success !== undefined) {
    progress.asserted = true;
    const checked = await checkExpectation(page, flow.success, network, consoleEvents);
    if (!checked.passed) {
      return {
        name: flow.name,
        status: RemoteFlowStatus.FAIL,
        detail: checked.failure ?? 'success expectation failed',
      };
    }
    if (checked.unsupported !== undefined) progress.unsupported = checked.unsupported;
  }
  if (progress.unsupported !== undefined) {
    return { name: flow.name, status: RemoteFlowStatus.UNVERIFIED, detail: progress.unsupported };
  }
  if (!progress.asserted) {
    return {
      name: flow.name,
      status: RemoteFlowStatus.UNVERIFIED,
      detail: 'flow has no remotely observable expectation',
    };
  }
  return { name: flow.name, status: RemoteFlowStatus.PASS };
}
