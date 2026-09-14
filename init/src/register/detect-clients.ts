import { join } from 'node:path';
import {
  ConfigScope,
  CURSOR_PROJECT_MARKER,
  McpClient,
  clientMarkerRelPath,
  fileBackedClients,
} from './mcp-clients.js';

/** One coding agent found on this machine, and the config it keeps. */
export interface DetectedClient {
  id: McpClient;
  configPath: string;
  existing: string | null;
}

/** The half of `InitIo` this needs. Narrow on purpose: detection reads, it never writes. */
export interface ClientProbe {
  exists(path: string): boolean;
  readFile(path: string): string | null;
  homeDir(): string;
}

/**
 * Which coding agents are actually on this machine.
 *
 * Extracted from `run.ts`, where it was inline, because `reticle setup mcp` asks the identical
 * question outside an install and a second copy of this is a second answer that can disagree with
 * the first. The rule it encodes is the reason it must not be duplicated: Reticle merges into a
 * config a client ALREADY has, and never creates `~/.gemini` or `~/.codeium` for somebody who does
 * not use them.
 */
export function detectMcpClients(io: ClientProbe): DetectedClient[] {
  return fileBackedClients()
    .map((spec) => {
      const marker = clientMarkerRelPath(spec);
      const absolute =
        spec.scope === ConfigScope.HOME ? join(io.homeDir(), spec.relPath) : spec.relPath;
      const markerPath = spec.scope === ConfigScope.HOME ? join(io.homeDir(), marker) : marker;
      // A fresh Cursor profile has not written ~/.cursor yet; the project-level .cursor/ is the
      // fallback that kept that real case working. Same signal, project scope.
      const projectFallback =
        spec.id === McpClient.CURSOR && !io.exists(markerPath)
          ? io.exists(CURSOR_PROJECT_MARKER)
          : false;
      if (!io.exists(markerPath) && !projectFallback) return null;
      return { id: spec.id, configPath: absolute, existing: io.readFile(absolute) };
    })
    .filter((entry): entry is DetectedClient => entry !== null);
}
