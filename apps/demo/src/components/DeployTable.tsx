import { useRef, useState } from 'react';
import { useApp } from '../store/store.js';
import type { Deployment } from '../data/seed.js';
import { EnvBadge, StatusBadge } from './primitives.js';
import { IconArrow, IconBolt, IconDots, IconDrag, IconGit } from './icons.js';

const ROW_H = 52;
const BUFFER = 4;

/** Windowed list (only the visible rows mount) → forces reticle_scroll_to for off-screen rows. */
export function DeployTable({ rows }: { rows: Deployment[] }): React.ReactElement {
  const openDrawer = useApp((s) => s.openDrawer);
  const ship = useApp((s) => s.shipDeployment);
  const reorder = useApp((s) => s.reorder);
  const selectedId = useApp((s) => s.selectedId);

  const [scrollTop, setScrollTop] = useState(0);
  const [menuFor, setMenuFor] = useState<number | null>(null);
  const [menuTop, setMenuTop] = useState(0);
  const [dragId, setDragId] = useState<number | null>(null);
  const drag = useRef<{ id: number; startY: number; index: number } | null>(null);

  const total = rows.length;
  const viewH = 460;
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - BUFFER);
  const end = Math.min(total, Math.ceil((scrollTop + viewH) / ROW_H) + BUFFER);
  const window = rows.slice(start, end);

  const onHandleDown = (e: React.PointerEvent, dep: Deployment, index: number): void => {
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { id: dep.id, startY: e.clientY, index };
    setDragId(dep.id);
  };
  const onHandleMove = (e: React.PointerEvent): void => {
    const d = drag.current;
    if (d === null) return;
    const wantOffset = Math.round((e.clientY - d.startY) / ROW_H);
    const curIndex = rows.findIndex((r) => r.id === d.id);
    const targetIndex = Math.max(0, Math.min(rows.length - 1, d.index + wantOffset));
    if (targetIndex !== curIndex) reorder(d.id, targetIndex > curIndex ? 1 : -1);
  };
  const onHandleUp = (): void => {
    drag.current = null;
    setDragId(null);
  };

  return (
    <div
      className="vlist"
      data-testid="deploy-list"
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      onClick={() => setMenuFor(null)}
    >
      <div style={{ height: total * ROW_H, position: 'relative' }}>
        {window.map((dep) => {
          const index = rows.indexOf(dep);
          return (
            <div
              key={dep.id}
              data-testid={`row-${dep.id}`}
              className={`vrow${selectedId === dep.id ? ' sel' : ''}${dragId === dep.id ? ' dragging' : ''}`}
              style={{ top: index * ROW_H, height: ROW_H }}
            >
              <div
                className="drag-handle"
                title="Drag to reorder"
                onPointerDown={(e) => onHandleDown(e, dep, index)}
                onPointerMove={onHandleMove}
                onPointerUp={onHandleUp}
              >
                <IconDrag size={15} />
              </div>

              <button
                type="button"
                data-testid={`open-detail-${dep.id}`}
                className="open-detail-action"
                onClick={() => openDrawer(dep.id)}
                style={{
                  background: 'none',
                  border: 'none',
                  textAlign: 'left',
                  cursor: 'pointer',
                  color: 'inherit',
                  minWidth: 0,
                }}
              >
                <div className="cell-name">{dep.service}</div>
                <div className="cell-sub" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <IconGit size={11} /> {dep.commit}
                </div>
              </button>

              <EnvBadge env={dep.env} />
              <StatusBadge status={dep.status} />
              <span className="cell-sub" style={{ fontSize: 12 }}>
                {dep.region}
              </span>
              <span className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>
                {dep.durationMs === 0 ? '—' : `${(dep.durationMs / 1000).toFixed(1)}s`}
              </span>

              <button
                type="button"
                className="row-menu-btn"
                data-testid={`row-menu-trigger-${dep.id}`}
                aria-label="Row actions"
                onClick={(e) => {
                  e.stopPropagation();
                  setMenuFor(menuFor === dep.id ? null : dep.id);
                  setMenuTop(index * ROW_H - scrollTop + ROW_H);
                }}
              >
                <IconDots size={16} />
              </button>

              {menuFor === dep.id ? (
                <div
                  className="popover"
                  data-testid="row-menu"
                  style={{ top: menuTop, right: 14 }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    type="button"
                    className="menu-item"
                    data-testid={`ship-${dep.id}`}
                    onClick={() => {
                      ship(dep.id);
                      setMenuFor(null);
                    }}
                  >
                    <IconBolt size={15} /> Ship now
                  </button>
                  <button
                    type="button"
                    className="menu-item"
                    data-testid={`detail-${dep.id}`}
                    onClick={() => {
                      openDrawer(dep.id);
                      setMenuFor(null);
                    }}
                  >
                    <IconArrow size={15} /> Open detail
                  </button>
                  <button
                    type="button"
                    className="menu-item"
                    onClick={() => {
                      reorder(dep.id, -1);
                      setMenuFor(null);
                    }}
                  >
                    Move up
                  </button>
                  <button
                    type="button"
                    className="menu-item"
                    onClick={() => {
                      reorder(dep.id, 1);
                      setMenuFor(null);
                    }}
                  >
                    Move down
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
