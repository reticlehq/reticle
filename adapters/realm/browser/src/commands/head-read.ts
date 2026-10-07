/**
 * The HEAD_READ command: the `<link rel>` and `<meta>` tags in the live `<head>` (#1425).
 *
 * Read from `document.head` when asked, so a tag a framework's head manager adds or rewrites after
 * load is seen. Only the head: a `<meta>` rendered into `<body>` is not one a crawler reads either.
 * Values are reported as the page wrote them, and redacted here, before they cross the bridge: a
 * meta named like a credential (Rails' `csrf-token`, Spring's `_csrf`), by `name` OR by `property`,
 * never leaves the page. Any value that is not the page's exact text says so with `altered`.
 */
import {
  HEAD_READ_MAX_TAGS,
  REDACTED_VALUE,
  isSensitiveKey,
  redactUrl,
  scrubKnownSecrets,
  type HeadSnapshot,
} from '@reticlehq/core';

/**
 * The longest value reported as is. The bridge cuts strings at 65,536 characters without saying so,
 * which would make a long value look complete; capping here, and flagging it, keeps that honest.
 */
export const HEAD_VALUE_MAX_CHARS = 2_048;

/** Links that say what they are, and metas that say what they are called. */
const HEAD_TAGS = 'link[rel], meta[name], meta[property]';
const LINK_TAG = 'link';

const capped = (value: string): string =>
  value.length > HEAD_VALUE_MAX_CHARS ? value.slice(0, HEAD_VALUE_MAX_CHARS) : value;

/** `{ altered: true }` when what is reported differs from what the page wrote, else nothing. */
const alteredFlag = (shown: string, raw: string): { altered?: true } =>
  shown === raw ? {} : { altered: true };

function linkOf(tag: Element): HeadSnapshot['links'][number] {
  const raw = tag.getAttribute('href') ?? '';
  const href = capped(redactUrl(raw));
  return { rel: tag.getAttribute('rel') ?? '', href, ...alteredFlag(href, raw) };
}

function metaOf(tag: Element): HeadSnapshot['metas'][number] {
  const name = tag.getAttribute('name') ?? undefined;
  const property = tag.getAttribute('property') ?? undefined;
  const raw = tag.getAttribute('content') ?? '';
  const sensitive = isSensitiveKey(name ?? '') || isSensitiveKey(property ?? '');
  const content = sensitive ? REDACTED_VALUE : capped(scrubKnownSecrets(raw));
  return {
    ...(name === undefined ? {} : { name }),
    ...(property === undefined ? {} : { property }),
    content,
    ...alteredFlag(content, raw),
  };
}

export function readHead(): HeadSnapshot {
  const links: HeadSnapshot['links'] = [];
  const metas: HeadSnapshot['metas'] = [];
  const tags = document.head.querySelectorAll(HEAD_TAGS);
  for (const tag of tags) {
    if (links.length + metas.length >= HEAD_READ_MAX_TAGS) return { links, metas, truncated: true };
    if (LINK_TAG === tag.localName) {
      links.push(linkOf(tag));
    } else {
      metas.push(metaOf(tag));
    }
  }
  return { links, metas };
}
