import { RETICLE_ROOT_GLOBAL, RETICLE_URL_PARAM } from '@reticlehq/core';
import { PresenterIcon, PRESENTER_ICON_SIZE, hiIconHtml } from './presenter-icons.js';

const WORKSPACE_BTN_ATTR = 'data-reticle-workspace-btn';
const WORKSPACE_MENU_ATTR = 'data-reticle-workspace-menu';
const WORKSPACE_NAME_ATTR = 'data-reticle-workspace-name';
const WORKSPACE_PATH_ATTR = 'data-reticle-workspace-path';
const WORKSPACE_PROJECT_ATTR = 'data-reticle-workspace-project';
const WORKSPACE_COPY_ATTR = 'data-reticle-workspace-copy';

const WORKSPACE_LABEL = 'Workspace';
const PROJECT_LABEL = 'Project';
const COPY_PATH_LABEL = 'Copy path';
const COPIED_PATH_LABEL = 'Copied';
const WORKSPACE_FALLBACK = 'This page';

/** Read the Vite-injected repo root, when present. */
export function readWorkspaceRoot(): string | undefined {
  const value = (globalThis as Record<string, unknown>)[RETICLE_ROOT_GLOBAL];
  return 'string' === typeof value && value.length > 0 ? value : undefined;
}

/** Last path segment for compact display (Codex/Cursor-style chip). */
export function workspaceFolderLabel(root: string): string {
  const normalized = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = normalized.split('/').filter((part) => part.length > 0);
  const last = parts[parts.length - 1];
  return last !== undefined && last.length > 0 ? last : WORKSPACE_FALLBACK;
}

/** Project id from the URL lease stamp, when present. */
export function readProjectIdFromUrl(): string | undefined {
  if ('undefined' === typeof window) return undefined;
  const id = new URLSearchParams(window.location.search).get(RETICLE_URL_PARAM.PROJECT);
  return id !== null && id.length > 0 ? id : undefined;
}

export function workspaceSummary(): { folder: string; root?: string; projectId?: string } {
  const root = readWorkspaceRoot();
  const projectId = readProjectIdFromUrl();
  const folder = root !== undefined ? workspaceFolderLabel(root) : WORKSPACE_FALLBACK;
  if (root === undefined && projectId === undefined) return { folder };
  const out: { folder: string; root?: string; projectId?: string } = { folder };
  if (root !== undefined) out.root = root;
  if (projectId !== undefined) out.projectId = projectId;
  return out;
}

/** Workspace chip + detail menu - sits above the composer row. */
export function workspaceRowHtml(): string {
  const folderIcon = hiIconHtml(PresenterIcon.LAYOUT, PRESENTER_ICON_SIZE.HELP);
  const caret = hiIconHtml(PresenterIcon.CARET_DOWN, PRESENTER_ICON_SIZE.HELP);
  const copyIcon = hiIconHtml(PresenterIcon.COPY, PRESENTER_ICON_SIZE.HELP);
  return `<div class="reticle-workspace-wrap">
    <button type="button" class="reticle-workspace" ${WORKSPACE_BTN_ATTR} aria-haspopup="true" aria-expanded="false" title="${WORKSPACE_LABEL}">
      <span class="reticle-workspace-icon" aria-hidden="true">${folderIcon}</span>
      <span class="reticle-workspace-name" ${WORKSPACE_NAME_ATTR}>${WORKSPACE_FALLBACK}</span>
      <span class="reticle-workspace-caret" aria-hidden="true">${caret}</span>
    </button>
    <div class="reticle-workspace-menu" ${WORKSPACE_MENU_ATTR} role="dialog" aria-label="${WORKSPACE_LABEL}" aria-hidden="true" hidden>
      <div class="reticle-workspace-menu-head">
        <div class="reticle-workspace-menu-title">${WORKSPACE_LABEL}</div>
        <button type="button" class="reticle-workspace-copy" ${WORKSPACE_COPY_ATTR} title="${COPY_PATH_LABEL}" aria-label="${COPY_PATH_LABEL}">${copyIcon}</button>
      </div>
      <div class="reticle-workspace-menu-row"><span class="reticle-workspace-menu-k">Folder</span><span class="reticle-workspace-menu-v" data-reticle-workspace-folder></span></div>
      <div class="reticle-workspace-menu-row"><span class="reticle-workspace-menu-k">Path</span><span class="reticle-workspace-menu-v reticle-workspace-menu-path" ${WORKSPACE_PATH_ATTR}></span></div>
      <div class="reticle-workspace-menu-row" data-reticle-workspace-project-row hidden><span class="reticle-workspace-menu-k">${PROJECT_LABEL}</span><span class="reticle-workspace-menu-v" ${WORKSPACE_PROJECT_ATTR}></span></div>
    </div>
  </div>`;
}

export function paintWorkspace(root: HTMLElement): void {
  const summary = workspaceSummary();
  // Nothing to say - no injected repo root, no leased project id - so the chip says nothing. It
  // used to render its fallback, "This page", which names no workspace and is exactly as true of
  // every page. The chip earns its slot only when it can tell you WHICH checkout is being driven.
  const wrap = root.querySelector('.reticle-workspace-wrap');
  if (wrap instanceof HTMLElement) {
    const known = summary.root !== undefined || summary.projectId !== undefined;
    wrap.toggleAttribute('hidden', !known);
  }
  const chipName = root.querySelector(`[${WORKSPACE_BTN_ATTR}] [${WORKSPACE_NAME_ATTR}]`);
  if (chipName instanceof HTMLElement) chipName.textContent = summary.folder;
  const folderEl = root.querySelector('[data-reticle-workspace-folder]');
  if (folderEl instanceof HTMLElement) folderEl.textContent = summary.folder;
  const pathEl = root.querySelector(`[${WORKSPACE_PATH_ATTR}]`);
  if (pathEl instanceof HTMLElement) {
    pathEl.textContent = summary.root ?? '-';
    pathEl.title = summary.root ?? '';
  }
  const projectEl = root.querySelector(`[${WORKSPACE_PROJECT_ATTR}]`);
  const projectRow = root.querySelector('[data-reticle-workspace-project-row]');
  const copyBtn = root.querySelector(`[${WORKSPACE_COPY_ATTR}]`);
  if (summary.projectId !== undefined) {
    projectRow?.removeAttribute('hidden');
    if (projectEl instanceof HTMLElement) projectEl.textContent = summary.projectId;
  } else {
    projectRow?.setAttribute('hidden', '');
    if (projectEl instanceof HTMLElement) projectEl.textContent = '';
  }
  if (copyBtn instanceof HTMLButtonElement) {
    copyBtn.disabled = summary.root === undefined;
  }
  const btn = root.querySelector(`[${WORKSPACE_BTN_ATTR}]`);
  if (btn instanceof HTMLElement && summary.root !== undefined) {
    btn.title = `${WORKSPACE_LABEL}: ${summary.root}`;
  }
}

export function mountWorkspaceSelector(root: HTMLElement): () => void {
  paintWorkspace(root);
  const btn = root.querySelector(`[${WORKSPACE_BTN_ATTR}]`);
  const menu = root.querySelector(`[${WORKSPACE_MENU_ATTR}]`);
  const copyBtn = root.querySelector(`[${WORKSPACE_COPY_ATTR}]`);
  if (!(btn instanceof HTMLElement) || !(menu instanceof HTMLElement)) return () => undefined;

  const close = (): void => {
    menu.setAttribute('aria-hidden', 'true');
    menu.setAttribute('hidden', '');
    btn.setAttribute('aria-expanded', 'false');
  };

  const open = (): void => {
    paintWorkspace(root);
    menu.removeAttribute('hidden');
    menu.setAttribute('aria-hidden', 'false');
    btn.setAttribute('aria-expanded', 'true');
  };

  const toggle = (): void => {
    if ('true' === menu.getAttribute('aria-hidden') || menu.hasAttribute('hidden')) open();
    else close();
  };

  const onBtnClick = (e: MouseEvent): void => {
    e.stopPropagation();
    toggle();
  };
  const onDocPointer = (e: PointerEvent): void => {
    const target = e.target;
    if (!(target instanceof Node)) return;
    if (btn.contains(target) || menu.contains(target)) return;
    close();
  };
  const onKeyDown = (e: KeyboardEvent): void => {
    if ('Escape' !== e.key) return;
    if ('true' === menu.getAttribute('aria-hidden') || menu.hasAttribute('hidden')) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  const onCopy = (e: Event): void => {
    e.stopPropagation();
    const path = workspaceSummary().root;
    if (path === undefined) return;
    void navigator.clipboard?.writeText(path);
    if (copyBtn instanceof HTMLButtonElement) {
      const prior = copyBtn.title;
      copyBtn.title = COPIED_PATH_LABEL;
      window.setTimeout(() => {
        copyBtn.title = prior;
      }, 1200);
    }
  };

  btn.addEventListener('click', onBtnClick);
  menu.addEventListener('pointerdown', (e) => e.stopPropagation());
  copyBtn?.addEventListener('click', onCopy);
  document.addEventListener('pointerdown', onDocPointer);
  document.addEventListener('keydown', onKeyDown);

  return (): void => {
    btn.removeEventListener('click', onBtnClick);
    copyBtn?.removeEventListener('click', onCopy);
    document.removeEventListener('pointerdown', onDocPointer);
    document.removeEventListener('keydown', onKeyDown);
  };
}
