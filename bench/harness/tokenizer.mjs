// Tokenizer for the OBSERVATION-COST layer.
//
// HONESTY NOTE: These tools feed their output into a Claude (Anthropic) context.
// The authoritative token count is Anthropic's, which we only get from the
// agent-loop layer (real usage.input_tokens). Here, with no API key, we report:
//   - chars        : exact character count of the payload (no estimation)
//   - bytes        : exact UTF-8 byte count
//   - tokens_o200k : tiktoken o200k_base count — a PROXY (OpenAI BPE), not Anthropic.
// We never present tokens_o200k as the Anthropic count; it is a reproducible,
// tool-agnostic proxy that ranks payloads consistently. Char/byte counts are exact.
import { execFileSync } from 'node:child_process';

export function countChars(s) {
  return s.length;
}
export function countBytes(s) {
  return Buffer.byteLength(s, 'utf8');
}

let tiktokenAvailable = null;
export function tiktokenOk() {
  if (tiktokenAvailable !== null) return tiktokenAvailable;
  try {
    execFileSync('python3', ['-c', 'import tiktoken'], { stdio: 'ignore' });
    tiktokenAvailable = true;
  } catch {
    tiktokenAvailable = false;
  }
  return tiktokenAvailable;
}

// Counts tokens with tiktoken o200k_base via a python subprocess.
// Returns null if tiktoken is unavailable (caller falls back to char/4 estimate, labeled).
export function countTokensProxy(s) {
  if (!tiktokenOk()) return null;
  const script =
    'import sys,tiktoken;enc=tiktoken.get_encoding("o200k_base");' +
    'print(len(enc.encode(sys.stdin.read())))';
  try {
    const out = execFileSync('python3', ['-c', script], {
      input: s,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return Number(out.trim());
  } catch {
    return null;
  }
}

// One call returning all three measures for a payload string.
export function measure(s) {
  const chars = countChars(s);
  const bytes = countBytes(s);
  const tokensProxy = countTokensProxy(s);
  return {
    chars,
    bytes,
    tokens_o200k: tokensProxy,
    tokens_charDiv4: Math.ceil(chars / 4), // crude fallback, always reported for transparency
  };
}
