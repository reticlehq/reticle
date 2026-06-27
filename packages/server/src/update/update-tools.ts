import { z } from 'zod';
import { IrisTool } from '../tools/tool-names.js';
import type { ToolDef, ToolDeps } from '../tools/tools.js';
import { checkForUpdate } from './update-checker.js';
import { applyUpdate, rollback, detectExecutionKind } from './updater.js';
import { SERVER_VERSION } from '../server-version.js';

export const UPDATE_TOOLS: ToolDef[] = [
  {
    name: IrisTool.VERSION_INFO,
    description:
      'Returns the running Iris version, latest available version, release changelog, and any breaking changes. Call this at the start of a session or when unexpected tool behavior suggests a version mismatch.',
    inputSchema: {},
    outputSchema: {
      currentVersion: z.string().describe('The Iris server version currently running.'),
      latestVersion: z.string().optional().describe('Latest published version on npm.'),
      updateAvailable: z.boolean().describe('True when a newer version is available to install.'),
      executionKind: z
        .string()
        .describe(
          'How iris was launched: "npx" (no install needed — restart applies update), "global" (npm install -g), or "local" (project node_modules).',
        ),
      changelog: z.string().optional().describe('Release notes for the latest version.'),
      breakingChanges: z
        .array(z.string())
        .optional()
        .describe('Breaking changes in the latest version that may affect your scripts.'),
      rollbackAvailable: z
        .boolean()
        .describe('True when a previous version is stored and can be restored.'),
      previousVersion: z
        .string()
        .optional()
        .describe('The version that would be restored on rollback.'),
    },
    handler: async (deps: ToolDeps) => {
      const manifest = await checkForUpdate(SERVER_VERSION, deps.now);
      return {
        currentVersion: manifest.currentVersion,
        ...(manifest.latestVersion !== undefined ? { latestVersion: manifest.latestVersion } : {}),
        updateAvailable: manifest.updateAvailable,
        executionKind: detectExecutionKind(),
        ...(manifest.changelog !== undefined ? { changelog: manifest.changelog } : {}),
        ...(manifest.breakingChanges !== undefined
          ? { breakingChanges: manifest.breakingChanges }
          : {}),
        rollbackAvailable: manifest.previousVersion !== undefined,
        ...(manifest.previousVersion !== undefined
          ? { previousVersion: manifest.previousVersion }
          : {}),
      };
    },
  },
  {
    name: IrisTool.APPLY_UPDATE,
    description:
      'Install the latest Iris server version and restart. Strategy depends on how iris was launched (check executionKind from iris_version_info): "global" and "local" installs run npm install then exit; "npx" just exits — Claude Code restarts and npx re-resolves the latest version from npm automatically. The MCP connection briefly drops during restart.',
    inputSchema: {
      confirm: z
        .boolean()
        .describe(
          'Set to true to confirm the update should be applied. Required to prevent accidental upgrades.',
        ),
    },
    outputSchema: {
      ok: z.boolean(),
      message: z.string().optional(),
    },
    handler: async (deps: ToolDeps, args: Record<string, unknown>) => {
      if (args['confirm'] !== true) {
        return { ok: false, message: 'Set confirm:true to apply the update' };
      }
      const manifest = await checkForUpdate(SERVER_VERSION, deps.now);
      if (!manifest.updateAvailable || manifest.latestVersion === undefined) {
        return { ok: false, message: 'No update available — already on the latest version' };
      }
      await applyUpdate(manifest.latestVersion);
      return { ok: true }; // unreachable — applyUpdate calls process.exit()
    },
  },
  {
    name: IrisTool.ROLLBACK,
    description:
      'Restore the previous Iris server version and restart. Use when an update introduced a regression. The MCP connection will briefly drop — Claude Code restarts the process automatically with the restored binary.',
    inputSchema: {
      confirm: z
        .boolean()
        .describe(
          'Set to true to confirm the rollback. Required to prevent accidental downgrades.',
        ),
    },
    outputSchema: {
      ok: z.boolean(),
      message: z.string().optional(),
    },
    handler: async (_deps: ToolDeps, args: Record<string, unknown>) => {
      if (args['confirm'] !== true) {
        return { ok: false, message: 'Set confirm:true to apply the rollback' };
      }
      await rollback();
      return { ok: true }; // unreachable — rollback() calls process.exit()
    },
  },
];
