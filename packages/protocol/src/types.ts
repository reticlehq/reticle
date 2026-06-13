import { z } from 'zod';
import { ElementState, QueryBy } from './constants.js';

/** A query describing which element(s) to find, Testing-Library style. */
export const ElementQuerySchema = z.object({
  by: z.nativeEnum(QueryBy).optional(),
  value: z.string().optional(),
  role: z.string().optional(),
  name: z.string().optional(),
  text: z.string().optional(),
  label: z.string().optional(),
  placeholder: z.string().optional(),
  testid: z.string().optional(),
  alt: z.string().optional(),
  /** CSS selector or ref to scope the search. */
  scope: z.string().optional(),
});
export type ElementQuery = z.infer<typeof ElementQuerySchema>;

/** Compact semantic descriptor of one element surfaced to the agent. */
export interface ElementDescriptor {
  ref: string;
  role: string;
  name: string;
  value?: string;
  states: ElementState[];
  visible: boolean;
  text?: string;
}

export interface MatchResult {
  matched: boolean;
  count: number;
  elements: ElementDescriptor[];
}

/** Diagnostic hint attached to a zero-match iris_query result (F4). */
export interface QueryEmptyHint {
  /** location.pathname + location.search at query time. */
  route: string;
  /** Up to ~12 data-testid values actually present in the searched DOM scope. */
  presentTestids: string[];
  /** True if a capability-registered testid is present in the scope. */
  knownEmptyState: boolean;
}

/** Result of the QUERY command / iris_query tool. `hint` present ONLY on zero matches. */
export interface QueryResult {
  elements: ElementDescriptor[];
  hint?: QueryEmptyHint;
}
