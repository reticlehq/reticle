/** One TCP listener and the process that owns it. */
export interface NetstatListener {
  readonly port: number;
  readonly pid: number;
}

const NETSTAT_PROTO = 'TCP';
const NETSTAT_STATE = 'LISTENING';
const NETSTAT_MIN_COLUMNS = 5;

/**
 * Parse Windows `netstat -ano` output.
 *
 * Read the port after the LAST colon so IPv6 addresses such as `[::]:3000`
 * are handled correctly. Do not restrict netstat to IPv4 with `-p tcp`.
 */
export function parseNetstatListeners(out: string): NetstatListener[] {
  const rows: NetstatListener[] = [];

  for (const line of String(out).split(/\r?\n/)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < NETSTAT_MIN_COLUMNS) continue;
    if (fields[0]?.toUpperCase() !== NETSTAT_PROTO || fields[3]?.toUpperCase() !== NETSTAT_STATE) {
      continue;
    }

    const localAddress = fields[1] ?? '';
    const port = Number(localAddress.slice(localAddress.lastIndexOf(':') + 1));
    const pid = Number(fields[4]);

    if (Number.isInteger(port) && port > 0 && Number.isInteger(pid) && pid > 0) {
      rows.push({ port, pid });
    }
  }

  return rows;
}
