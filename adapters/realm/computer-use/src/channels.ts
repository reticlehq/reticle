/**
 * The channels this realm reports on, and the label of each kind of observation.
 */
import { ChannelId } from 'open-verification';

export const CuChannel = {
  UI: ChannelId.UI,
  /** That a path exists and its size: the file system decided it. */
  FILES: 'x-files',
  /** The bytes in a path: the application wrote them. */
  FILES_CONTENT: 'x-files-content',
} as const;

/** Stable labels. A claim matches on them exactly. */
export const CuSummary = {
  UI_APPEARED: 'cu.ui.appeared',
  UI_GONE: 'cu.ui.gone',
  UI_CHANGED: 'cu.ui.changed',
  /** The action was delivered and no element appeared, went away or changed. */
  UI_NO_EFFECT: 'cu.ui.no-effect',
  /** The action reached an element a person could not click. */
  ACT_NOT_REACHABLE: 'cu.act.not-reachable',
  FS_WRITTEN: 'cu.fs.written',
  FS_WRITTEN_EMPTY: 'cu.fs.written-empty',
  FS_DELETED: 'cu.fs.deleted',
  FS_CONTENT: 'cu.fs.content',
} as const;

export const CU_SURFACE = 'x-computer-use';
