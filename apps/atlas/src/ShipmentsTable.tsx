import { useEffect, useRef, useState } from 'react';
import { reticle } from '@reticlehq/browser';
import { useAtlas, type Shipment } from './store.js';

/**
 * The shipments table: virtualized, filterable, paginated, and mutated by a push stream.
 *
 * Three things here are hard for a verifier, and none of them is a planted trick:
 *
 *  - **Only ~20 of 10,000 rows exist in the DOM.** A snapshot is structurally a sample. Asserting
 *    "row X shows Y" is meaningless unless X happens to be scrolled into view.
 *  - **Rows change with no action behind them.** Scan events arrive constantly, so "the DOM moved
 *    after my click" is not evidence that my click moved it.
 *  - **A dispatch renders as success immediately** and the server reconciles ~1.2s later, sometimes
 *    reverting it. The optimistic row and the eventual truth are both real states of this UI.
 */

const ROW_HEIGHT = 34;
const OVERSCAN = 6;

/**
 * Minor units → major. Note what it does NOT take: the row's currency.
 *
 * Written the way this is usually written — one formatter, added when every row was INR, never
 * revisited when USD and EUR rows appeared. The caller supplies the symbol, and there is only one
 * symbol in the JSX. Nothing here is planted; it is what a shared helper looks like after a
 * requirement changed and the helper did not.
 */
function money(minor: number): string {
  return (minor / 100).toLocaleString('en-IN', { minimumFractionDigits: 2 });
}

export function ShipmentsTable(): React.ReactElement {
  const {
    rows,
    total,
    page,
    size,
    status,
    search,
    loading,
    selected,
    setRows,
    setLoading,
    setStatus,
    setSearch,
    setPage,
    optimisticDispatch,
    applyServerVersion,
    toggleSelected,
    setError,
  } = useAtlas();
  const [scrollTop, setScrollTop] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);

  // Load whenever the query changes. No request sequencing — the slow `all` response can land after
  // a fast filtered one, which is a race produced by latency rather than by a flag.
  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({
      status,
      page: String(page),
      size: String(size),
      ...(search.length > 0 ? { search } : {}),
    });
    void fetch(`/api/shipments?${params.toString()}`)
      .then((r) => r.json())
      .then((data: { rows: Shipment[]; total: number; page: number }) => {
        setRows(data.rows, data.total, data.page);
        reticle.signal('shipments:loaded', { count: data.rows.length, total: data.total });
      })
      .catch(() => {
        setError('could not load shipments');
      });
  }, [status, search, page, size, setRows, setLoading, setError]);

  // The push stream. Scan events bump a row's version; reconciliation may REVERT a dispatch.
  useEffect(() => {
    const source = new EventSource('/api/events');
    source.addEventListener('scan', (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as {
        shipmentId: string;
        version: number;
      };
      applyServerVersion(data.shipmentId, data.version);
    });
    source.addEventListener('reconciled', (event) => {
      const data = JSON.parse((event as MessageEvent<string>).data) as {
        shipmentId: string;
        reverted: boolean;
        status: string;
      };
      applyServerVersion(data.shipmentId, 0, data.status);
      reticle.signal('dispatch:reconciled', { id: data.shipmentId, reverted: data.reverted });
    });
    return () => {
      source.close();
    };
  }, [applyServerVersion]);

  const dispatch = (id: string): void => {
    // Optimistic: the row says "dispatched" before the server has decided anything.
    optimisticDispatch(id);
    void fetch('/api/dispatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `dispatch-${id}` },
      body: JSON.stringify({ shipmentId: id }),
    }).catch(() => {
      setError('dispatch failed');
    });
  };

  /**
   * Hold every selected shipment.
   *
   * Written the way this is usually written: the request succeeds, so the banner reports the number
   * REQUESTED. The endpoint answers 200 with per-item results inside the body, and a third of them
   * carry `carrier_locked` — so the banner is wrong whenever anything failed, and every channel above
   * the body agrees with it. Not a planted defect; trusting the envelope is the default behaviour of
   * every fetch wrapper anyone writes.
   */
  const holdSelected = (): void => {
    const ids = [...selected];
    void fetch('/api/bulk-hold', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ids }),
    })
      .then((res) => {
        if (!res.ok) throw new Error('bulk hold failed');
        setNotice(`${String(ids.length)} shipments held`);
      })
      .catch(() => {
        setError('bulk hold failed');
      });
  };

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visible = rows.slice(start, start + Math.ceil(560 / ROW_HEIGHT) + OVERSCAN * 2);
  const pages = Math.max(1, Math.ceil(total / size));

  return (
    <section style={{ padding: 20 }}>
      <h1 data-testid="title">Shipments</h1>
      <p data-testid="summary">
        {total} shipments · page {page} of {pages}
      </p>

      {null === notice ? null : <p data-testid="notice">{notice}</p>}
      <button data-testid="hold-selected" disabled={0 === selected.length} onClick={holdSelected}>
        Hold selected
      </button>

      <div style={{ display: 'flex', gap: 8, margin: '12px 0' }} role="group" aria-label="filters">
        {['all', 'draft', 'dispatched', 'in_transit', 'delivered', 'held'].map((s) => (
          <button
            key={s}
            role="radio"
            aria-checked={status === s}
            data-testid={`filter-${s}`}
            onClick={() => {
              setStatus(s);
            }}
            style={{ fontWeight: status === s ? 700 : 400 }}
          >
            {s}
          </button>
        ))}
        <input
          data-testid="search"
          placeholder="ref…"
          onChange={(e) => {
            setSearch(e.target.value);
          }}
        />
      </div>

      {loading ? <p data-testid="loading">loading…</p> : null}

      <div
        ref={viewportRef}
        data-testid="viewport"
        onScroll={(e) => {
          setScrollTop(e.currentTarget.scrollTop);
        }}
        style={{ height: 560, overflowY: 'auto', border: '1px solid #ccc' }}
      >
        <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
          {visible.map((row, i) => (
            <div
              key={row.id}
              data-testid={`row-${row.id}`}
              style={{
                position: 'absolute',
                top: (start + i) * ROW_HEIGHT,
                height: ROW_HEIGHT,
                display: 'flex',
                gap: 12,
                alignItems: 'center',
                width: '100%',
              }}
            >
              <input
                type="checkbox"
                aria-label={`select ${row.ref}`}
                checked={selected.includes(row.id)}
                onChange={() => {
                  toggleSelected(row.id);
                }}
              />
              <span data-testid={`ref-${row.id}`}>{row.ref}</span>
              <span>{row.carrier}</span>
              <span>
                {row.origin} → {row.destination}
              </span>
              <span data-testid={`status-${row.id}`}>{row.status}</span>
              <span data-testid={`value-${row.id}`}>₹{money(row.declaredValueMinor)}</span>
              <button
                data-testid={`dispatch-${row.id}`}
                onClick={() => {
                  dispatch(row.id);
                }}
              >
                Dispatch
              </button>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button
          data-testid="prev"
          disabled={page <= 1}
          onClick={() => {
            setPage(page - 1);
          }}
        >
          Previous
        </button>
        <button
          data-testid="next"
          onClick={() => {
            setPage(page + 1);
          }}
        >
          Next
        </button>
      </div>
    </section>
  );
}
