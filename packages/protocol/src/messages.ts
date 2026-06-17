import { z } from 'zod';
import {
  EventType,
  HumanControlKind,
  IRIS_PROTOCOL_VERSION,
  MessageKind,
  TRANSPORT_LIMITS,
} from './constants.js';

const sessionIdSchema = z.string().min(1).max(TRANSPORT_LIMITS.MAX_SESSION_ID_LENGTH);
const refSchema = z.string().max(TRANSPORT_LIMITS.MAX_REF_LENGTH);

/**
 * Live-control: the narrowed payload of a HUMAN_CONTROL event. The server safeParses
 * `event.data` against this at the inbound boundary (unknown → narrowed; never `any`).
 */
export const HumanControlDataSchema = z.object({
  kind: z.nativeEnum(HumanControlKind),
  text: z.string().optional(),
});
export type HumanControlData = z.infer<typeof HumanControlDataSchema>;

/**
 * A normalized observation pushed from the browser into the ring buffer.
 * `t` is a monotonic millisecond timestamp relative to session start (clock injected,
 * never `Date.now()` inside pure logic — see plan engineering standards).
 */
export const IrisEventSchema = z.object({
  t: z.number(),
  type: z.nativeEnum(EventType),
  sessionId: sessionIdSchema,
  /** Stable element reference this event concerns, when applicable (e.g. "e7"). */
  ref: refSchema.optional(),
  /** Event-type-specific payload. Kept open here; refined per observer at the edges. */
  data: z.record(z.unknown()).default({}),
});
export type IrisEvent = z.infer<typeof IrisEventSchema>;

/** Browser announces itself to the bridge on connect. */
export const HelloMessageSchema = z.object({
  kind: z.literal(MessageKind.HELLO),
  protocolVersion: z.literal(IRIS_PROTOCOL_VERSION),
  sessionId: sessionIdSchema,
  url: z.string().max(TRANSPORT_LIMITS.MAX_URL_LENGTH),
  title: z.string().max(TRANSPORT_LIMITS.MAX_TITLE_LENGTH),
  adapters: z
    .array(z.string().max(TRANSPORT_LIMITS.MAX_ADAPTER_NAME_LENGTH))
    .max(TRANSPORT_LIMITS.MAX_ADAPTERS),
  /** Optional browser/bridge pairing token. Required when the bridge configures one. */
  token: z.string().max(TRANSPORT_LIMITS.MAX_TOKEN_LENGTH).optional(),
  /** Whether the app has advertised a capability registry (iris.describe). */
  hasCapabilities: z.boolean().optional(),
});
export type HelloMessage = z.infer<typeof HelloMessageSchema>;

/** Agent -> browser request, routed by the bridge with a correlation id. */
export const CommandMessageSchema = z.object({
  kind: z.literal(MessageKind.COMMAND),
  id: z.string().min(1).max(TRANSPORT_LIMITS.MAX_COMMAND_ID_LENGTH),
  sessionId: sessionIdSchema.optional(),
  name: z.string().min(1).max(TRANSPORT_LIMITS.MAX_COMMAND_NAME_LENGTH),
  args: z.record(z.unknown()).default({}),
});
export type CommandMessage = z.infer<typeof CommandMessageSchema>;

/** Browser -> agent reply to a command. */
export const CommandResultSchema = z.object({
  kind: z.literal(MessageKind.COMMAND_RESULT),
  id: z.string().min(1).max(TRANSPORT_LIMITS.MAX_COMMAND_ID_LENGTH),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().max(TRANSPORT_LIMITS.MAX_ERROR_LENGTH).optional(),
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
