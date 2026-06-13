import { z } from 'zod';
import { EventType, MessageKind } from './constants.js';

/**
 * A normalized observation pushed from the browser into the ring buffer.
 * `t` is a monotonic millisecond timestamp relative to session start (clock injected,
 * never `Date.now()` inside pure logic — see plan engineering standards).
 */
export const IrisEventSchema = z.object({
  t: z.number(),
  type: z.nativeEnum(EventType),
  sessionId: z.string(),
  /** Stable element reference this event concerns, when applicable (e.g. "e7"). */
  ref: z.string().optional(),
  /** Event-type-specific payload. Kept open here; refined per observer at the edges. */
  data: z.record(z.unknown()).default({}),
});
export type IrisEvent = z.infer<typeof IrisEventSchema>;

/** Browser announces itself to the bridge on connect. */
export const HelloMessageSchema = z.object({
  kind: z.literal(MessageKind.HELLO),
  protocolVersion: z.number(),
  sessionId: z.string(),
  url: z.string(),
  title: z.string(),
  adapters: z.array(z.string()),
  /** Whether the app has advertised a capability registry (iris.describe). */
  hasCapabilities: z.boolean().optional(),
});
export type HelloMessage = z.infer<typeof HelloMessageSchema>;

/** Agent -> browser request, routed by the bridge with a correlation id. */
export const CommandMessageSchema = z.object({
  kind: z.literal(MessageKind.COMMAND),
  id: z.string(),
  sessionId: z.string().optional(),
  name: z.string(),
  args: z.record(z.unknown()).default({}),
});
export type CommandMessage = z.infer<typeof CommandMessageSchema>;

/** Browser -> agent reply to a command. */
export const CommandResultSchema = z.object({
  kind: z.literal(MessageKind.COMMAND_RESULT),
  id: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});
export type CommandResult = z.infer<typeof CommandResultSchema>;

/** Browser -> bridge streamed observation. */
export const EventMessageSchema = z.object({
  kind: z.literal(MessageKind.EVENT),
  event: IrisEventSchema,
});
export type EventMessage = z.infer<typeof EventMessageSchema>;

export const IrisMessageSchema = z.discriminatedUnion('kind', [
  HelloMessageSchema,
  CommandMessageSchema,
  CommandResultSchema,
  EventMessageSchema,
]);
export type IrisMessage = z.infer<typeof IrisMessageSchema>;
