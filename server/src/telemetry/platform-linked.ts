/**
 * `platform_linked`: a project on this machine was bound to a workspace.
 *
 * The join between OSS usage and the platform. The platform holds who is in each workspace; this
 * event, and every event after it from a linked project, carries only the workspace's pseudonymous
 * id. So a person is never named on this side, and the two sides still meet on `workspaceId`.
 *
 * Once per NEW binding: re-running `link` against the project a repo already reports to (rotating a
 * key, an agent retrying) is not a link being created.
 */
import { PlatformLinkVia, TelemetryEventKind } from '@reticlehq/core/telemetry';
import { onPlatformLinked, type PlatformLinked } from '@/command/cli/cloud-link.js';
import { getTelemetry, type Telemetry } from './telemetry.js';

export function reportPlatformLinked(
  link: PlatformLinked,
  telemetry: Pick<Telemetry, 'emit'> = getTelemetry(),
): void {
  if (link.priorProjectId === link.projectId) return;
  try {
    void telemetry.emit(TelemetryEventKind.PLATFORM_LINKED, {
      link: { via: link.via },
      ...(link.workspaceId === undefined ? {} : { workspaceId: link.workspaceId }),
      // A CLI command exits straight after; the daemon (a HUD link) sends in-process.
      detach: PlatformLinkVia.HUD !== link.via,
    });
  } catch {
    /* a metric never fails a link */
  }
}

/** Report every link this process makes. Installed once, by the entry point. */
export function installPlatformLinkTelemetry(): void {
  onPlatformLinked((link) => reportPlatformLinked(link));
}
