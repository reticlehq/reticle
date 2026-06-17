const DANGEROUS_ACTION =
  /\b(delete|remove|destroy|erase|drop|terminate|revoke|reset|logout|log out|sign out|close account|cancel subscription|purchase|buy|pay|place order|confirm order|deploy|publish|send|transfer|withdraw|refund)\b/i;

/** True only for literal loopback hosts, never lookalike DNS names such as 127.example.com. */
export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') {
    return true;
  }
  const octets = normalized.split('.');
  return (
    octets.length === 4 &&
    octets[0] === '127' &&
    octets.every((octet) => {
      if (!/^\d{1,3}$/.test(octet)) return false;
      const value = Number(octet);
      return value >= 0 && value <= 255;
    })
  );
}

/** Best-effort classifier for labels and tool names that can trigger irreversible effects. */
export function isDangerousActionText(text: string): boolean {
  return DANGEROUS_ACTION.test(text.replace(/[_-]+/g, ' '));
}
