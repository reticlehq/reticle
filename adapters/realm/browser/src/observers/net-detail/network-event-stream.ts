/** Project bounded SSE data through the same structured redaction as JSON responses. */
import { REDACTED_VALUE } from '@reticlehq/core/page';
import { sanitizeWithReport } from '@/security/serialization.js';

const EVENT_STREAM_CONTENT = /^text\/event-stream(?:\s*;|\s*$)/i;
const DATA_FIELD = 'data:';
const DATA_NAME = 'data';
const JSON_CONTAINER = /^[{[]/;
const TEXT_MARKER = /^\[[A-Z_]+\]$/;

export function isEventStream(contentType: string | null): boolean {
  return contentType !== null && EVENT_STREAM_CONTENT.test(contentType);
}

function isData(line: string): boolean {
  return DATA_NAME === line || line.startsWith(DATA_FIELD);
}

/** Incomplete JSON cannot be redacted safely. Replace it and declare the lost data. */
export function redactEventStream(text: string): { body: string; truncated: boolean } {
  let truncated = false;
  const records = text.replace(/\r\n?/g, '\n').split('\n\n');
  const body = records
    .map((record) => {
      const lines = record.split('\n');
      const data = lines
        .filter(isData)
        .map((line) => line.slice(DATA_FIELD.length).replace(/^ /, ''))
        .join('\n');
      if (!JSON_CONTAINER.test(data.trimStart()) || TEXT_MARKER.test(data.trim())) {
        return record;
      }
      let projected: string;
      try {
        const sanitized = sanitizeWithReport(JSON.parse(data));
        projected = JSON.stringify(sanitized.value);
        if (sanitized.truncation !== undefined) {
          truncated = true;
        }
      } catch {
        projected = REDACTED_VALUE;
        truncated = true;
      }
      let first = true;
      return lines
        .flatMap((line) => {
          if (!isData(line)) {
            return [line];
          }
          if (!first) {
            return [];
          }
          first = false;
          return [`${DATA_FIELD} ${projected}`];
        })
        .join('\n');
    })
    .join('\n\n');
  return { body, truncated };
}
