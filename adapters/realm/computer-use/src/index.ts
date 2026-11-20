/**
 * The front door.
 *
 * The part of the computer-use realm that needs no operating system: the element shape every
 * reader gives, the tree text an agent reads, and the effect of an action.
 */
export { UiRole, place } from './ui-node.js';
export type { Placed, UiNode } from './ui-node.js';
export { AxNodeSchema, fromAx } from './mac/from-ax.js';
export type { AxNode, FromAx } from './mac/from-ax.js';
export { RefTable, writeLines } from './lines.js';
export { ChangeKind, EffectKind, changeLine, effectOf } from './effect.js';
export type { Change, Effect } from './effect.js';
export { ComputerUseRealm } from './computer-use-realm.js';
export type { ComputerUseRealmDeps, Described } from './computer-use-realm.js';
export { CU_SURFACE, CuChannel, CuSummary } from './channels.js';
export { ActKind, ActRefusal, Delivery } from './driver.js';
export type { ActOutcome, ActRequest, SettingChange, UiDriver, UiRead } from './driver.js';
export { MacDriver } from './mac/mac-driver.js';
export type { MacDriverInput, RunHelper } from './mac/mac-driver.js';
export {
  CLIPBOARD_CHANGED_SIGNAL,
  DISK_WROTE_SIGNAL,
  FILE_SIGNAL_PREFIX,
  PEER_ACTIONS,
  PEER_COMMANDS,
  PeerCommands,
  SETTINGS_CHANGED_SIGNAL,
} from './peer/commands.js';
export type { Emit, PeerCommandsDeps } from './peer/commands.js';
export { connectPeer } from './peer/peer.js';
export type { Peer, PeerInput } from './peer/peer.js';
export { attachPlan } from './attach.js';
export type { AttachPlan } from './attach.js';
export { doctorReport } from './doctor.js';
export type { DoctorFacts, DoctorReport } from './doctor.js';
