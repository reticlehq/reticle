import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { health } from '../lib/api.js';
import { readEnterpriseConfig } from '../lib/enterprise-config.js';

/**
 * The enterprise-scale fixture: what every other fixture in this app is not. Hostile is ~150 nodes
 * at depth ~4 with no network; every overhead and payload number we publish therefore describes a
 * small flat page. This view is the honest counterpart — a real data grid under a design-system
 * wrapper chain, with the four costs an enterprise React app actually imposes on an observer:
 *
 * - node count      ~10k real elements (rows x cells x a button per cell)
 * - depth           every leaf sits under ~15 generic wrapper divs, so ancestor walks are deep
 * - match breadth   thousands of `button` roles and thousands of `enterprise-cell-*` testids, so a
 *                   broad query has to decide what NOT to send
 * - continuous work CSS transitions firing on a rotating band of rows, ~20 req/sec of background
 *                   polling, and a few-hundred-node subtree mounting/unmounting every second
 *
 * Inert unless the URL enables it (see enterprise-config.ts) — it must not move any existing number.
 */

const GRID_TESTID = 'enterprise-grid';
const VIEW_TESTID = 'enterprise-view';
const CHURN_TESTID = 'enterprise-churn-panel';
const POLL_COUNT_TESTID = 'enterprise-poll-count';
const CELL_TESTID_PREFIX = 'enterprise-cell';
const ROW_CLASS = 'ent-row';
const HOT_CLASS = 'ent-hot';
const STATUSES = ['live', 'building', 'failed', 'queued'] as const;
const NODES_PER_CHURN_ITEM = 2; // one wrapper div + one span
const HOT_BAND_SIZE = 40; // rows toggled per tick — enough transitionend traffic to matter

/**
 * Scoped so the fixture carries its own cost and adds nothing to the shared stylesheet. The
 * transitions are the point: hovering a row, or the rotating "hot" band, fires transitionend
 * continuously the way a real app's row hover/selection states do.
 */
const ENTERPRISE_CSS = `
.ent-layer { display: contents; }
.${ROW_CLASS} {
  display: flex;
  gap: 8px;
  padding: 2px 6px;
  border-bottom: 1px solid rgba(255,255,255,0.04);
  background-color: transparent;
  transition: background-color 180ms ease, transform 180ms ease, opacity 180ms ease;
}
.${ROW_CLASS}:hover { background-color: rgba(120,170,255,0.14); transform: translateX(2px); }
.${ROW_CLASS}.${HOT_CLASS} { background-color: rgba(255,180,120,0.18); opacity: 0.85; }
.ent-cell { flex: 1 1 0; min-width: 0; font-size: 12px; }
.ent-cell button { width: 100%; text-align: left; font: inherit; }
.ent-grid { max-height: 420px; overflow: auto; contain: content; }
`;

interface GridSpec {
  rows: number;
  cols: number;
  depth: number;
}

function buildRow(row: number, cols: number): React.ReactElement {
  const cells: React.ReactElement[] = [];
  for (let col = 0; col < cols; col += 1) {
    const status = STATUSES[(row + col) % STATUSES.length] ?? STATUSES[0];
    cells.push(
      <div className="ent-cell" role="gridcell" key={col}>
        <button type="button" data-testid={`${CELL_TESTID_PREFIX}-r${String(row)}-c${String(col)}`}>
          svc-{row}·{col} {status}
        </button>
      </div>,
    );
  }
  return (
    <div className={ROW_CLASS} role="row" aria-rowindex={row + 1} key={row}>
      {cells}
    </div>
  );
}

/** The design-system wrapper chain: `depth` generic divs between the view and the grid. */
function wrapInLayers(inner: React.ReactElement, depth: number): React.ReactElement {
  let node = inner;
  for (let level = depth; level > 0; level -= 1) {
    node = (
      <div className="ent-layer" data-ent-layer={level}>
        {node}
      </div>
    );
  }
  return node;
}

function buildGrid({ rows, cols, depth }: GridSpec): React.ReactElement {
  const body: React.ReactElement[] = [];
  for (let row = 0; row < rows; row += 1) body.push(buildRow(row, cols));
  return wrapInLayers(
    <div className="ent-grid" role="grid" data-testid={GRID_TESTID} aria-rowcount={rows}>
      {body}
    </div>,
    depth,
  );
}

export function Enterprise(): React.ReactElement {
  const cfg = useMemo(readEnterpriseConfig, []);
  const [polls, setPolls] = useState(0);
  const [churnOn, setChurnOn] = useState(true);
  const gridRef = useRef<HTMLDivElement | null>(null);

  // Built once per config: the poll counter re-rendering 20x/sec must not rebuild 10k elements.
  const grid = useMemo(
    () => buildGrid({ rows: cfg.rows, cols: cfg.cols, depth: cfg.depth }),
    [cfg.rows, cfg.cols, cfg.depth],
  );

  // Background network churn against the real API (default ~20 req/sec).
  useEffect(() => {
    if (0 === cfg.pollHz) return;
    const id = setInterval(
      () => {
        void health().then(() => setPolls((n) => n + 1));
      },
      Math.max(1, Math.round(1000 / cfg.pollHz)),
    );
    return () => clearInterval(id);
  }, [cfg.pollHz]);

  // Mount/unmount churn: a few-hundred-node subtree appearing and vanishing on a timer, so
  // MutationObserver work scales with subtree size rather than with single nodes.
  useEffect(() => {
    if (0 === cfg.churnMs || 0 === cfg.churnNodes) return;
    const id = setInterval(() => setChurnOn((on) => !on), cfg.churnMs);
    return () => clearInterval(id);
  }, [cfg.churnMs, cfg.churnNodes]);

  // A rotating band of rows gets the hot class, which drives the CSS transition.
  // ponytail: toggled imperatively — re-rendering 1000 rows to move a highlight would measure
  // React's cost, not the observer's. Swap to state if the band ever needs to be readable state.
  useEffect(() => {
    if (0 === cfg.hotMs || 0 === cfg.rows) return;
    let band = 0;
    const id = setInterval(() => {
      const root = gridRef.current;
      if (null === root) return;
      for (const el of root.querySelectorAll(`.${HOT_CLASS}`)) el.classList.remove(HOT_CLASS);
      const rows = root.querySelectorAll(`.${ROW_CLASS}`);
      for (let i = 0; i < HOT_BAND_SIZE; i += 1) {
        rows[(band + i) % Math.max(1, rows.length)]?.classList.add(HOT_CLASS);
      }
      band = (band + HOT_BAND_SIZE) % Math.max(1, rows.length);
    }, cfg.hotMs);
    return () => clearInterval(id);
  }, [cfg.hotMs, cfg.rows]);

  const churnItems = Math.floor(cfg.churnNodes / NODES_PER_CHURN_ITEM);

  return (
    <section data-testid={VIEW_TESTID}>
      <style>{ENTERPRISE_CSS}</style>
      <h2>Enterprise grid</h2>
      <p>
        rows {cfg.rows} · cols {cfg.cols} · depth {cfg.depth} · poll {cfg.pollHz}/s · polls done{' '}
        <span data-testid={POLL_COUNT_TESTID}>{polls}</span>
      </p>

      {churnOn && cfg.churnNodes > 0 && cfg.churnMs > 0 ? (
        <div data-testid={CHURN_TESTID}>
          {Array.from({ length: churnItems }, (_, i) => (
            <div key={i}>
              <span>churn {i}</span>
            </div>
          ))}
        </div>
      ) : null}

      <div ref={gridRef}>{grid}</div>
    </section>
  );
}
