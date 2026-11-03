import { useEffect, useState } from 'react';
import { useApp } from '../store/store.js';

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
 */
const API = 'http://localhost:8787/api/rule-pairs';
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

async function readPage(list: string): Promise<void> {
  await fetch(`${API}/${list}?page=1`);
}

export function RulePairs(): React.ReactElement {
  const [saved, setSaved] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(0);
  const [batch, setBatch] = useState('');

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
