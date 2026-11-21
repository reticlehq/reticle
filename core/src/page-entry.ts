/**
 * `@reticlehq/core/page` — what the SDK reads on a page's first load, and nothing that needs zod.
 *
 * The SDK imports this entry, not core's root, for every value it uses on the way in. The root
 * exports every module in core, schemas included, and a bundler that sees the root on the first
 * load also puts there every module a later chunk uses through it: one schema brought most of zod
 * (about 95 KB) onto every page (#2369). Only zod-free modules are named here.
 * `first-load-size.test.ts` fails when zod reaches the first load.
 *
 * Generated from the SDK's imports. A value the SDK needs on the way in is added here, from the
 * module that defines it.
 */
export {
  AnchorKind,
  AnnotationKind,
  DEGRADED_ANCHOR_ROLE,
  FLOW_FILE_VERSION,
  RecorderPhase,
} from './artifacts/flow-constants.js';
export { ACT_STEP_TOOL } from './artifacts/flow-step-tool.js';
export { CreditKind, IMPACT_DEFECT_LIMIT } from './artifacts/impact-constants.js';
export { BrowserBrand } from './browser-brand.js';
export { asRef } from './identity/brand.js';
export { CONTRACT_FINGERPRINT, CONTRACT_PARTS, fnv1a } from './identity/contract-fingerprint.js';
export { newDocumentId } from './identity/document-identity.js';
export { NO_EDITS_OBSERVED } from './identity/edit-epoch.js';
export {
  DATA_RETICLE_SOURCE_ATTR,
  RETICLE_ROOT_GLOBAL,
  RETICLE_SDK_VERSION_GLOBAL,
} from './identity/source-constants.js';
export {
  ALTERNATIVE_TESTID_ATTRS,
  DEFAULT_TESTID_ATTR,
  TESTID_ATTR_PATTERN,
} from './identity/testid-attribute.js';
export { PredicateKind } from './verdict/consequence.js';
export { SESSION_REF } from './verdict/predicate-tree.js';
export {
  OutwardAction,
  dangerousActionWord,
  dangerousNavigationReason,
  destructiveActionWord,
  isDangerousActionText,
  isDangerousNavigation,
  isInertHref,
  isLocalPage,
  isLoopbackHostname,
  isPaymentField,
  outwardActionOf,
  outwardRefusal,
  withoutFilenameTokens,
} from './verdict/security.js';
export { STEP_SCREENSHOT } from './verdict/step-screenshot.js';
export { BlindSpotKind } from './verdict/verified-constants.js';
export { ChannelId } from './wire/channel.js';
export {
  ACT_POINT_ARG,
  ClickButton,
  DRAG_TO_POINT_ARG,
  actPointProblem,
  boxFractionFromArgs,
  clickButtonFromArgs,
  clickInputProblem,
  pointInBox,
} from './wire/click-input.js';
export { ANIMATION_TARGET_ARG } from './wire/constants/animation-command.js';
export {
  DROPPED_PRE_ATTACH_FIELD,
  PRE_ATTACH_FIELD,
  RETICLE_PRE_ATTACH_ERRORS,
} from './wire/constants/console-event.js';
export {
  ALLOW_OCCLUDED_ARG,
  ActionType,
  ActionWarning,
  ComponentStateReason,
  DANGEROUS_ACTION_CONFIRM_ARG,
  DEFAULT_PLATFORM_URL,
  ElementState,
  INSPECT_IN_VIEWPORT_FIELD,
  INSPECT_REVEAL_ARG,
  MessageKind,
  NATIVE_INPUT_ARG,
  PerfMetric,
  PresenterMode,
  QueryBy,
  REDACTED_VALUE,
  RETICLE_BUSY_SIGNAL,
  RETICLE_DEFAULT_PORT,
  RETICLE_PROTOCOL_VERSION,
  RETICLE_RENDERS_STORE,
  RETICLE_SESSION_STORAGE_KEY,
  RETICLE_URL_PARAM,
  RETICLE_WS_PATH,
  ReticleCommand,
  SettleReason,
  SnapshotMode,
  TRANSPORT_LIMITS,
  TruncationChannel,
  VisualReason,
  bridgeWsUrl,
} from './wire/constants/constants.js';
export { DETERMINISM_GLOBAL_KEY } from './wire/constants/determinism.js';
export { DISCOVERY_CALL_URL, FOUNDER_EMAIL, FOUNDER_MAILTO } from './wire/constants/discovery.js';
export {
  CanvasTrigger,
  EventType,
  FieldChangeField,
  FieldChangeKind,
  LivePoliteness,
  MediaEvent,
  ROUTE_CHANGE_HOW_FIELD,
  RouteChangeHow,
  ScrollDirection,
  StorageArea,
  StreamDirection,
  StreamTransport,
} from './wire/constants/event-types.js';
export {
  FlowProgressStatus,
  HUD_RELOAD_TO_RESTORE,
  HudCorner,
  HudPanel,
  HudPromptSurface,
  HudToggle,
  HudView,
  HudVisibility,
  ScriptStatus,
} from './wire/constants/hud-use.js';
export { MatchArg } from './wire/constants/match-args.js';
export { ResponseBodyReason } from './wire/constants/response-body-reason.js';
export { RETICLE_OVERLAY_SELECTOR } from './wire/constants/reticle-chrome.js';
export {
  HealthReason,
  HumanControlKind,
  MarkAnchorStrategy,
  SESSION_AUTO,
  SESSION_HEALTH,
  SESSION_LIFECYCLE,
  SessionState,
  isSessionState,
} from './wire/constants/session-constants.js';
export { CoverageMarker, SOURCE_MAPPING_CAPABILITY } from './wire/coverage-marker.js';
export { RETICLE_IPC_GLOBAL, RETICLE_TAURI_CAPTURE_COMMAND } from './wire/desktop-contract.js';
export { CHURN_TYPES } from './wire/event-classification.js';
export { isGlobalPress, pressKeyFromArgs, pressKeysFromArgs } from './wire/global-press.js';
export { clampHoldMs } from './wire/hold.js';
export {
  IPC_URL_SCHEME,
  IpcStatus,
  NEXT_ACTION_FIELD,
  NEXT_ACTION_HEADER,
  NetInitiator,
  REQUEST_SHAPE_FIELD,
  REQUEST_SHAPE_NONE,
} from './wire/net.js';
export { CommandActor, parseCommandMessage, parseElementQuery } from './wire/page-parse.js';
export { PlatformProfile } from './wire/platform.js';
export { HelloInstrumentation } from './wire/production/hello-mode.js';
export {
  buildRedactionPolicy,
  isSensitiveKey,
  netUrlFields,
  redactUrl,
  scrubKnownSecrets,
  setActiveRedactionPolicy,
  wireRedactionKeys,
} from './wire/redaction.js';
export { capDepth, selectPath } from './wire/state-select.js';
export { PresenterTone, isPresenterTone } from './words/notices.js';
export { UNREACHABLE_NOTICE_PREFIX } from './words/unreachable-notice.js';
