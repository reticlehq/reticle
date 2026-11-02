import { useEffect, useState } from 'react';

/**
 * The two shapes that the `stale-response-applied` rule must tell apart in a real browser.
 *
 * #2087 and #2097 both changed this rule after false `no` verdicts from the field, and only unit
 * tests covered those changes. This view gives the rule a gate in both directions:
 *
 *  - Fan-out (the rule must stay silent). One click opens two panels. Each panel reads one path with
 *    its own `type`. The first read answers about 100ms after the second. Both answers are wanted.
 *  - Real race (the rule must report). Two filter clicks overlap and the older answer lands last.
 *    This app does not drop it, so the control says `held` and the rows show `all`.
 */
const API = 'http://localhost:8787';

/**
 * The second panel reads this long after the first. Reads less than 2ms apart count as one task, so
 * a shorter gap keeps the rule silent for a different reason and the fixture proves nothing.
 */
const SECOND_PANEL_GAP_MS = 20;

async function readItems(type: string): Promise<string> {
  const res = await fetch(`${API}/api/stale-race/items?type=${type}`);
  const body = (await res.json()) as { type: string };
  return body.type;
}

function Panel({ type, gapMs }: { type: string; gapMs: number }): React.ReactElement {
  const [answer, setAnswer] = useState('');

  useEffect(() => {
    const timer = setTimeout(() => {
      void readItems(type).then(setAnswer);
    }, gapMs);
    return () => clearTimeout(timer);
  }, [type, gapMs]);

  return (
    <output data-testid={`stale-race-panel-${type}`}>
      {'' === answer ? 'loading' : `Panel ${answer} ready`}
    </output>
  );
}

export function StaleRace(): React.ReactElement {
  const [panelsOpen, setPanelsOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const [rows, setRows] = useState('');

  // The defect, on purpose: nothing cancels an older read and nothing drops its answer.
  const choose = (value: string): void => {
    setFilter(value);
    void readItems(value).then(setRows);
  };

  return (
    <div className="view">
      <div className="panel panel-pad" style={{ maxWidth: 560 }}>
        <h3 data-testid="stale-race-heading">Fan-out</h3>
        <button data-testid="stale-race-open-panels" onClick={() => setPanelsOpen(true)}>
          Open panels
        </button>
        {panelsOpen ? (
          <>
            <Panel type="a" gapMs={0} />
            <Panel type="b" gapMs={SECOND_PANEL_GAP_MS} />
          </>
        ) : null}
      </div>
      <div className="panel panel-pad" style={{ maxWidth: 560 }}>
        <h3>Filter race</h3>
        <button data-testid="stale-race-filter-all" onClick={() => choose('all')}>
          All
        </button>
        <button data-testid="stale-race-filter-held" onClick={() => choose('held')}>
          Held
        </button>
        <output data-testid="stale-race-filter">{filter}</output>
        <output data-testid="stale-race-rows">{rows}</output>
      </div>
    </div>
  );
}
