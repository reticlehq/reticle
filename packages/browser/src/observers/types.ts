import type { EventType } from '@syrin/protocol';

/** An observer emits normalized events; the orchestrator stamps time + forwards them. */
export type Emit = (type: EventType, data: Record<string, unknown>, ref?: string) => void;

/** Every observer returns a teardown that fully restores any patched globals. */
export type Teardown = () => void;
