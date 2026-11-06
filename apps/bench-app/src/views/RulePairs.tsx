import { useEffect, useState } from 'react';
import { useApp } from '../store/store.js';
import { emit, Sig } from '../lib/reticle-bridge.js';

/**
 * The shapes that three narrowed rules must tell apart in a real browser.
 *
 * #1627, #1629 and #2127 each made a rule report less often, and only unit tests covered those
 * changes (#2141). A rule that reports less can hide a real defect as a pass. Each panel gives one
 * rule a gate in both directions: one control the rule must report, and one it must not.
 *
 *  - `write-field-ignored`: a save that echoes the same id with the old values (report), and a
 *    duplicate that answers a new record with its own id, or a price echoed as `18.500` for `18.5`
 *    (silent).
 *  - `action-had-no-effect`: a dead button while a click counter moves its store path (report), and a button
 *    whose only effect is a store path that was quiet before (silent).
 *  - `pagination-not-fetched`: a bare `1 of 6` label that moves while the app asks for page 1 again
 *    (report), and a `0 of 6 selected` count that moves with the same request (silent).
 *  - `partial-failure-in-ok-response`: a batch write that answers 200 with one failed item (report),
 *    and a read of a job list that holds old failed jobs (silent).
 *  - a `net` miss over a `fetch` saved before connect(): `unknown`, not `no` (#1660), and the same
 *    ping through `window.fetch` passes.
 *  - `write-field-ignored` beside an optimistic lock: a PUT whose echo bumps `lock_version` and keeps
 *    the title (silent), and the same PUT whose echo returns an old title (report).
 *  - reach: a switch inside a closed `<details>`, a switch inside a `display: none` panel, and a
 *    button under a full-screen overlay (the spec adds the overlay). A person cannot click any of
 *    them, so a request they send must not give `yes`. A switch that a person can reach sends the
 *    same request and must still give `yes`.
 *  - `signal-contradicted` over a declared 409: a `form:submit` signal fired before the invite was
 *    sent (silent), and an `invite:sent` signal fired after the 409 (report) (#2172).
 */
const API = 'http://localhost:8787/api/rule-pairs';
/**
 * `fetch` as it was when this module loaded. `main.tsx` imports the app before it calls
 * `installReticle()`, so this is the browser's own `fetch`, saved before connect() patched it. A
 * client library that stores `window.fetch` when it loads does the same (#1660).
 */
const savedFetch = window.fetch.bind(window);
/** Two routes for one ping, so the call that goes through the patch never names the saved one. */
const PING_SAVED = 'ping/saved';
const PING_PATCHED = 'ping/patched';
const PROFILE = { id: 'profile-1', name: 'New name', plan: 'pro' };
const TOTAL = 6;
/**
 * Counts every click on the page, as an analytics or "last interaction" store does. Earlier clicks
 * move this path before the dead click, and the dead click moves it inside its own window. So the
 * path is background churn that is IN the window, which is the shape #1629 must still report. A
 * timer cannot do that: an act window can be shorter than any interval.
 */
function countClick(): void {
  useApp.setState({ rulePairsClicks: useApp.getState().rulePairsClicks + 1 });
}

async function post(path: string): Promise<void> {
  await fetch(`${API}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(PROFILE),
  });
}

/** The text the invite panel shows when the server refuses a duplicate email. */
const DUPLICATE_EMAIL = 'Another account already uses this email.';

async function invite(): Promise<Response> {
  return fetch(`${API}/invite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'ana@example.com' }),
  });
}

/** A compare-and-set update. The server answers with `lock_version` one higher. */
const LOCKED_DOC = { id: 'doc-1', title: 'Q3 plan', lock_version: 3 };

async function putLocked(outcome: string): Promise<void> {
  await fetch(`${API}/lock/${outcome}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(LOCKED_DOC),
  });
}

async function readPage(list: string): Promise<void> {
  await fetch(`${API}/${list}?page=1`);
}

export function RulePairs(): React.ReactElement {
  const [saved, setSaved] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(0);
  const [batch, setBatch] = useState('');
  const [invited, setInvited] = useState('');

  useEffect(() => {
    void readPage('pages');
    void readPage('rows');
    document.addEventListener('click', countClick, true);
    return () => document.removeEventListener('click', countClick, true);
  }, []);

  return (
    <div className="view">
      <div className="panel panel-pad" style={{ maxWidth: 560 }}>
        <h3>Echo</h3>
        <button
          data-testid="rule-pairs-save"
          onClick={() => void post('profile').then(() => setSaved('Saved'))}
        >
          Save profile
        </button>
        <button
          data-testid="rule-pairs-duplicate"
          onClick={() => void post('derive').then(() => setSaved('Duplicated'))}
        >
          Duplicate profile
        </button>
        <button
          data-testid="rule-pairs-price"
          onClick={() =>
            void fetch(`${API}/price`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: 'item-1', price: '18.5' }),
            }).then(() => setSaved('Price saved'))
          }
        >
          Save price
        </button>
        <button
          data-testid="rule-pairs-lock-kept"
          onClick={() => void putLocked('kept').then(() => setSaved('Plan saved'))}
        >
          Save plan
        </button>
        {/* The defect, on purpose: the server keeps the old title and the app says saved. */}
        <button
          data-testid="rule-pairs-lock-lost"
          onClick={() => void putLocked('lost').then(() => setSaved('Plan saved again'))}
        >
          Save plan again
        </button>
        <output data-testid="rule-pairs-saved">{saved}</output>
      </div>
      <div className="panel panel-pad" style={{ maxWidth: 560 }}>
        <h3>Effect</h3>
        {/* The defect, on purpose: this button has no handler. */}
        <button data-testid="rule-pairs-dead">Archive</button>
        <button
          data-testid="rule-pairs-remember"
          onClick={() => useApp.setState({ rulePairsChoice: 'remembered' })}
        >
          Remember
        </button>
      </div>
      <div className="panel panel-pad" style={{ maxWidth: 560 }}>
        <h3>Saved fetch</h3>
        <button
          data-testid="rule-pairs-ping-saved"
          onClick={() => void savedFetch(`${API}/${PING_SAVED}`, { method: 'POST' })}
        >
          Ping through a saved fetch
        </button>
        <button
          data-testid="rule-pairs-ping-patched"
          onClick={() => void fetch(`${API}/${PING_PATCHED}`, { method: 'POST' })}
        >
          Ping through window.fetch
        </button>
      </div>
      <div className="panel panel-pad" style={{ maxWidth: 560 }}>
        <h3>Batch</h3>
        {/* The defect, on purpose: the app says done although one item failed. */}
        <button
          data-testid="rule-pairs-batch"
          onClick={() =>
            void fetch(`${API}/batch`, { method: 'POST' }).then(() => setBatch('All items held'))
          }
        >
          Hold all
        </button>
        <button
          data-testid="rule-pairs-jobs"
          onClick={() => void fetch(`${API}/jobs`).then(() => setBatch('Jobs refreshed'))}
        >
          Refresh jobs
        </button>
        <output data-testid="rule-pairs-batch-status">{batch}</output>
      </div>
      <div className="panel panel-pad" style={{ maxWidth: 560 }}>
        <h3>Reach</h3>
        <details>
          <summary>Players</summary>
          <button role="switch" aria-checked="false" onClick={() => void post('toggle')}>
            Stream eligible
          </button>
        </details>
        <button role="switch" aria-checked="false" onClick={() => void post('toggle')}>
          Stream public
        </button>
        <button onClick={() => void post('toggle')}>Publish roster</button>
        <div hidden>
          <button role="switch" aria-checked="false" onClick={() => void post('toggle')}>
            Stream archived
          </button>
        </div>
      </div>
      <div className="panel panel-pad" style={{ maxWidth: 560 }}>
        <h3>Invite</h3>
        {/* Correct: the submit signal fires before the invite is sent, and the 409 is shown. */}
        <button
          data-testid="rule-pairs-invite-early"
          onClick={() => {
            emit(Sig.FORM_SUBMIT);
            void invite().then(() => setInvited(DUPLICATE_EMAIL));
          }}
        >
          Invite
        </button>
        {/* The defect, on purpose: the app says the invite was sent although the server refused it. */}
        <button
          data-testid="rule-pairs-invite-claimed"
          onClick={() =>
            void invite().then(() => {
              emit(Sig.INVITE_SENT);
              setInvited('Invitation sent');
            })
          }
        >
          Invite and claim
        </button>
        <output data-testid="rule-pairs-invited">{invited}</output>
      </div>
      <div className="panel panel-pad" style={{ maxWidth: 560 }}>
        <h3>Pagination</h3>
        {/* The defect, on purpose: the label moves and the app asks for page 1 again. */}
        <button
          data-testid="rule-pairs-next"
          onClick={() => {
            setPage(page + 1);
            void readPage('pages');
          }}
        >
          Next
        </button>
        {/* One text node, so the label change is one DOM text event. */}
        <output data-testid="rule-pairs-page">{`${String(page)} of ${String(TOTAL)}`}</output>
        <button
          data-testid="rule-pairs-select"
          onClick={() => {
            setSelected(selected + 1);
            void readPage('rows');
          }}
        >
          Select row
        </button>
        <output data-testid="rule-pairs-selected">
          {`${String(selected)} of ${String(TOTAL)} selected`}
        </output>
      </div>
    </div>
  );
}
