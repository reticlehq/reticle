import { z } from 'zod';
import { IrisTool } from './tool-names.js';
import { asNumber, asString } from './tools-helpers.js';
import { scrollToFind, type ScrollFindQuery } from './scroll-find.js';
import type { ToolDef, ToolDeps } from './tools.js';

/**
 * N5 SCROLLFIND: iris_scroll_to — the windowed/virtualized-list escape hatch. A plain iris_query
 * only sees rendered nodes, so an off-screen row in a react-window/react-virtualized list returns
 * nothing. This scrolls the container until the row mounts, then returns its ref.
 */
export const SCROLL_TOOLS: ToolDef[] = [
  {
    name: IrisTool.SCROLL_TO,
    description:
      'Find an element that a VIRTUALIZED/windowed list has not rendered yet: scrolls the container ~a viewport at a time (re-querying after each) until the match mounts, the list ends, or maxScrolls (default 20) is spent. Pass the list container ref as `container` (else the document scrolls). Use this when iris_query returns nothing but you expect a row further down. Returns { found, element?, scrolls, exhausted } (exhausted:true ⇒ hit the list end; false ⇒ hit the scroll budget).',
    inputSchema: {
      by: z.string(),
      value: z.string(),
      name: z.string().optional(),
      container: z.string().optional(),
      maxScrolls: z.number().optional(),
      ...{ sessionId: z.string().optional() },
    },
    handler: (deps: ToolDeps, args) => {
      const session = deps.sessions.resolve(asString(args['sessionId']));
      const name = asString(args['name']);
      const container = asString(args['container']);
      const q: ScrollFindQuery = {
        by: asString(args['by']) ?? '',
        value: asString(args['value']) ?? '',
        ...(name !== undefined ? { name } : {}),
        ...(container !== undefined ? { container } : {}),
      };
      const maxScrolls = asNumber(args['maxScrolls']);
      return scrollToFind(session, q, maxScrolls !== undefined ? { maxScrolls } : {});
    },
  },
];
