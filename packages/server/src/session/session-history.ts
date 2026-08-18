import { join } from 'node:path';
import type { FileSystemPort } from '../project/fs-port.js';

const FILE_NAME = 'session-history.json';

function historyPath(root: string): string {
  return join(root, FILE_NAME);
}

export async function readEverConnected(fs: FileSystemPort, root: string): Promise<boolean> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(historyPath(root)));
    return (
      'object' === typeof parsed &&
      parsed !== null &&
      'everConnected' in parsed &&
      true === parsed.everConnected
    );
  } catch (error) {
    if (!fs.isNotFound(error)) return false;
    return false;
  }
}

export async function writeEverConnected(fs: FileSystemPort, root: string): Promise<void> {
  await fs.mkdir(root);
  await fs.writeFile(historyPath(root), '{"everConnected":true}\n');
}
