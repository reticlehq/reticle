import { EventType, type IrisEvent } from '@syrin/protocol';

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/** Match a net.request event against optional method/url/status filters (iris_network). */
export function matchNet(
  e: IrisEvent,
  method: string | undefined,
  urlContains: string | undefined,
  status: number | undefined,
): boolean {
  const d = e.data;
  if (method !== undefined && asString(d['method'])?.toUpperCase() !== method.toUpperCase()) {
    return false;
  }
  if (urlContains !== undefined && !(asString(d['url']) ?? '').includes(urlContains)) {
    return false;
  }
  if (status !== undefined && asNumber(d['status']) !== status) return false;
  return true;
}

/** Match a console/error event against an optional level filter (iris_console). */
export function matchConsole(e: IrisEvent, level: string | undefined): boolean {
  const isConsole =
    e.type === EventType.CONSOLE_LOG ||
    e.type === EventType.CONSOLE_WARN ||
    e.type === EventType.CONSOLE_ERROR ||
    e.type === EventType.ERROR_UNCAUGHT;
  if (!isConsole) return false;
  if (level === undefined) return true;
  return (
    e.type === `console.${level}` || (level === 'error' && e.type === EventType.ERROR_UNCAUGHT)
  );
}
