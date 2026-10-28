/**
 * The bin that agent configs start the MCP server from, when this CLI is an install that stays on
 * disk. Undefined for npx's cache and other run-once copies: see `installedLauncher` in init.
 */
import { fileURLToPath } from 'node:url';
import { installedLauncher } from '@reticlehq/init';

/** `bin/reticle.js`, from `dist/command/setup/mcp-launcher.js`. The real path, not a symlink. */
export const CLI_BIN = fileURLToPath(new URL('../../../bin/reticle.js', import.meta.url));

export function mcpLauncher(): string | undefined {
  return installedLauncher(CLI_BIN);
}
