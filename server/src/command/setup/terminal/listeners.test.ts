import { describe, expect, it } from 'vitest';
import {
  descendants,
  parseLsofPorts,
  parseNetstatListeners,
  parseWmicProcesses,
} from './listeners.js';

describe('port discovery', () => {
  it('reads ports out of the lsof NAME column', () => {
    expect(parseLsofPorts('127.0.0.1:3000\n*:5173\n[::1]:8080')).toEqual([3000, 5173, 8080]);
  });

  it('has nothing to report when nothing listens', () => {
    expect(parseLsofPorts('')).toEqual([]);
  });
});

// Real `netstat -ano` output. The IPv6 rows are the point: splitting the local address on ':' and
// taking index 1 reads `[::]:3000` as port 0, which silently loses half the table on the one
// platform where this is the only way to find a port at all.
const NETSTAT = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:3000           0.0.0.0:0              LISTENING       4812
  TCP    [::]:3000              [::]:0                 LISTENING       4812
  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       9001
  TCP    192.168.1.4:52344      104.18.2.1:443         ESTABLISHED     7777
  UDP    0.0.0.0:5353           *:*                                    600
`;

describe('netstat parsing', () => {
  it('keeps only LISTENING TCP rows', () => {
    expect(
      parseNetstatListeners(NETSTAT)
        .map((r) => r.port)
        .sort((a, b) => a - b),
    ).toEqual([3000, 3000, 5173]);
  });

  it('reads the port after the LAST colon, so IPv6 rows survive', () => {
    expect(parseNetstatListeners('  TCP    [::]:3000    [::]:0    LISTENING    4812')).toEqual([
      { port: 3000, pid: 4812 },
    ]);
  });

  it('ignores established connections and udp', () => {
    const pids = parseNetstatListeners(NETSTAT).map((r) => r.pid);
    expect(pids).not.toContain(7777);
    expect(pids).not.toContain(600);
  });

  it('treats unparseable output as no listeners rather than throwing', () => {
    expect(parseNetstatListeners('not netstat output at all')).toEqual([]);
  });
});

describe('process descendants', () => {
  // `npm run dev` starts a shell, which starts node, which binds the port. Matching only the pid we
  // hold finds nothing, and nothing looks exactly like "no server is running".
  const TREE = [
    { pid: 200, ppid: 100 },
    { pid: 300, ppid: 200 },
    { pid: 400, ppid: 999 },
  ];

  it('walks past the shell to the process that actually binds', () => {
    expect(descendants(TREE, 100).sort((a, b) => a - b)).toEqual([100, 200, 300]);
  });

  it('does not sweep in an unrelated tree', () => {
    expect(descendants(TREE, 100)).not.toContain(400);
  });

  it('terminates on a cycle', () => {
    expect(
      descendants(
        [
          { pid: 1, ppid: 2 },
          { pid: 2, ppid: 1 },
        ],
        1,
      ).sort((a, b) => a - b),
    ).toEqual([1, 2]);
  });

  it('reads wmic columns as parent then child', () => {
    expect(
      parseWmicProcesses('ParentProcessId  ProcessId\n100              200\n200              300'),
    ).toEqual([
      { pid: 200, ppid: 100 },
      { pid: 300, ppid: 200 },
    ]);
  });
});

// Windows never clears ParentProcessId when a parent exits, and it reuses pids. A long-lived service
// started by a process that once held our dev server's pid still names that pid as its parent, so a
// walk by ppid alone adopts it. On a CI runner that was sshd: `init` reported port 22 as the dev
// server ("watching http://localhost:22") and waited for a page that could never come. A real child
// is created after its parent, so an older "child" is a stale link, not a descendant.
describe('stale parent links after pid reuse', () => {
  const OURS = 1_000;
  const pairs = [
    { pid: 100, ppid: 4, startedAtMs: OURS },
    { pid: 200, ppid: 100, startedAtMs: OURS + 50 },
    { pid: 300, ppid: 200, startedAtMs: OURS + 90 },
    { pid: 22, ppid: 100, startedAtMs: OURS - 3_600_000 },
  ];

  it('does not adopt a process that is older than the parent it names', () => {
    expect(descendants(pairs, 100)).not.toContain(22);
  });

  it('still walks the real tree', () => {
    expect(descendants(pairs, 100).sort((a, b) => a - b)).toEqual([100, 200, 300]);
  });

  it('keeps the ppid-only walk when creation times are unknown', () => {
    const untimed = pairs.map(({ pid, ppid }) => ({ pid, ppid }));
    expect(descendants(untimed, 100)).toContain(22);
  });

  it('reads wmic CreationDate, which it prints first (alphabetical columns)', () => {
    expect(
      parseWmicProcesses(
        'CreationDate               ParentProcessId  ProcessId\r\n' +
          '20261011095501.250000+000  100              200\r\n' +
          '20261011102501.000000+330  200              300\r\n',
      ),
    ).toEqual([
      { pid: 200, ppid: 100, startedAtMs: Date.UTC(2026, 9, 11, 9, 55, 1, 250) },
      // +330 is minutes east of UTC: 10:25:01 local is 04:55:01 UTC.
      { pid: 300, ppid: 200, startedAtMs: Date.UTC(2026, 9, 11, 4, 55, 1, 0) },
    ]);
  });

  it('reads a row with no creation time as the old two-column shape', () => {
    expect(parseWmicProcesses('0 4\r\n')).toEqual([{ pid: 4, ppid: 0 }]);
  });
});

// The fallback source when `wmic` is absent, which Microsoft has been making the normal case.
// node-effects asks PowerShell for the same pairs and hands the output to this same parser, so the
// shape it prints is a contract. If this stops reading it, Windows silently loses port discovery
// and `init` reports a healthy dev server as hung.
describe('the PowerShell fallback prints a shape this parser reads', () => {
  it('reads `ParentProcessId ProcessId` lines with CRLF endings', () => {
    expect(parseWmicProcesses('1234 5678\r\n4 8\r\n\r\n')).toEqual([
      { pid: 5678, ppid: 1234 },
      { pid: 8, ppid: 4 },
    ]);
  });

  it('ignores the blank and ragged lines PowerShell adds', () => {
    expect(parseWmicProcesses('\r\n  \r\n7 9\r\nnot numbers here\r\n')).toEqual([
      { pid: 9, ppid: 7 },
    ]);
  });
});
