import { ReticleTool, type ToolInvoker } from '@reticle/server';

/** The deterministic-time facade exposed as `t.clock`. Each call maps to one reticle_clock knob. */
export interface TestClock {
  freeze(): Promise<void>;
  advance(ms: number): Promise<void>;
  reset(): Promise<void>;
}

function clockArgs(knob: Record<string, unknown>, sessionId?: string): Record<string, unknown> {
  return { ...knob, ...(sessionId !== undefined ? { sessionId } : {}) };
}

/** Build a TestClock bound to one invoker + session. Each method calls reticle_clock with one knob. */
export function buildClock(invoke: ToolInvoker, sessionId?: string): TestClock {
  return {
    async freeze(): Promise<void> {
      await invoke(ReticleTool.CLOCK, clockArgs({ freeze: true }, sessionId));
    },
    async advance(ms: number): Promise<void> {
      await invoke(ReticleTool.CLOCK, clockArgs({ advanceMs: ms }, sessionId));
    },
    async reset(): Promise<void> {
      await invoke(ReticleTool.CLOCK, clockArgs({ reset: true }, sessionId));
    },
  };
}
