/**
 * Advice for a `bodyContains` clause the session cannot satisfy.
 *
 * The setting `captureNetworkBodies` landed in SDK 2.1.0. Printing it against an older page — or
 * against a session where capture is already on — sends the caller to change something that cannot
 * help, which is worse than silence. Three states, three messages:
 *
 *   - SDK predates the setting (or the version is unknown once bodies are already missing): name
 *     both versions, never the setting.
 *   - SDK supports it and it is off: name `connect({ captureNetworkBodies: true })` and the Vite
 *     env var, which is the runtime alternative when the caller cannot edit config.
 *   - Capture is on: return nothing. An unread payload then means this call was not stringified,
 *     not that recording is disabled.
 */
import { compareVersions } from '../version/version-skew.js';

/** First `@reticlehq/browser` release whose `connect()` accepted `captureNetworkBodies`. */
export const BODY_CAPTURE_SINCE = '2.1.0';

const CONNECT_CAPTURE = 'reticle.connect({ captureNetworkBodies: true })';
const PLUGIN_CAPTURE = 'reticle({ captureNetworkBodies: true })';
const CAPTURE_ENV = 'VITE_RETICLE_CAPTURE_BODIES=1';

export interface BodyCaptureFacts {
  sdkVersion?: string | undefined;
  /**
   * From HELLO: `true`/`false` when this SDK announced the field, `undefined` when omitted
   * (every SDK before the announcement, including ones that already support the setting).
   */
  captureNetworkBodies?: boolean | undefined;
  /**
   * After the fact: a matching call carried no recorded body. Turns an omitted HELLO flag into
   * "off" so the caller still gets a version-aware sentence. Must not be set from HELLO alone —
   * a modern SDK that does not yet announce the flag would then be told to enable a setting it
   * may already have on.
   */
  bodiesMissing?: boolean;
}

export function sdkSupportsBodyCapture(sdkVersion: string | undefined): boolean {
  const order = compareVersions(sdkVersion, BODY_CAPTURE_SINCE);
  return undefined !== order && 0 <= order;
}

/**
 * Why this session cannot satisfy a body assertion, or `undefined` when it can (or when we
 * cannot yet tell).
 */
export function bodyCaptureRemedy(input: BodyCaptureFacts): string | undefined {
  if (true === input.captureNetworkBodies) return undefined;

  const announcedOff = false === input.captureNetworkBodies;
  const supports = announcedOff || sdkSupportsBodyCapture(input.sdkVersion);

  if (announcedOff || true === input.bodiesMissing) {
    return supports ? supportedOffRemedy() : unsupportedRemedy(input.sdkVersion);
  }

  // Preflight, flag omitted: only a known-old SDK is decidable without looking at a body.
  if (undefined !== input.sdkVersion && !sdkSupportsBodyCapture(input.sdkVersion)) {
    return unsupportedRemedy(input.sdkVersion);
  }
  return undefined;
}

function unsupportedRemedy(sdkVersion: string | undefined): string {
  if (undefined === sdkVersion || 0 === sdkVersion.length) {
    return (
      `this session's SDK version is unknown; body capture needs SDK >= ${BODY_CAPTURE_SINCE}, ` +
      'so this assertion is not available here.'
    );
  }
  return (
    `this session's SDK is ${sdkVersion}; body capture needs >= ${BODY_CAPTURE_SINCE}, ` +
    'so this assertion is not available here.'
  );
}

function supportedOffRemedy(): string {
  return (
    `Turn it on where your app calls connect(): \`${CONNECT_CAPTURE}\`, or for the Vite plugin ` +
    `\`${PLUGIN_CAPTURE}\` / ${CAPTURE_ENV}. Then re-run the action.`
  );
}
