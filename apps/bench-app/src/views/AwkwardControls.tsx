import { useEffect, useRef, useState } from 'react';

/**
 * Three properties of real applications that this repo had no fixture for, and that between them
 * account for a large share of what the last field export could not verify.
 *
 * Each is here because a fix shipped against unit tests alone, or because a whole capability was
 * reported as absent and nothing here could demonstrate it either way.
 *
 * 1. A FILE INPUT. There was no `<input type="file">` anywhere under `apps/`, so the upload path had
 *    never been driven end to end — which is exactly how the recorder and the replayer came to
 *    disagree about what an upload step IS. The recorder wrote `{path}` and the replayer only
 *    accepted `{name, content, type}`, so a recorded upload could never replay, and no flow touching
 *    document ingestion, avatar upload or CSV import could be green.
 *
 * 2. AN ICON-ONLY BUTTON WITH NO ACCESSIBLE NAME. Reported as undriveable. The honest behaviour is
 *    to say the control has no name — never to quietly match it to something else, and never to
 *    report it as absent when it is plainly there.
 *
 * 3. A CANVAS. Reticle's model of an app is DOM + store + network, which is complete for CRUD apps
 *    and empty for 3D ones. A team adopting Reticle for a canvas app does not discover that until
 *    they try to verify the feature they care about, because everything around the canvas verifies
 *    fine. The fixture exists so the honesty of that gap can be pinned rather than argued about.
 */
const API = 'http://localhost:8787';

export function AwkwardControls(): React.ReactElement {
  const [score, setScore] = useState('');
  const [picked, setPicked] = useState('');
  const [clicks, setClicks] = useState(0);
  const canvas = useRef<HTMLCanvasElement | null>(null);

  // Paint something, so the canvas is a real surface with content rather than an empty element that
  // could be dismissed as "nothing to see".
  useEffect(() => {
    const ctx = canvas.current?.getContext('2d');
    if (null === ctx || ctx === undefined) return;
    ctx.fillStyle = '#0b3d5c';
    ctx.fillRect(0, 0, 240, 120);
    ctx.fillStyle = '#7fd1ff';
    ctx.fillRect(20, 30, 80, 60);
    ctx.fillText('inside the canvas', 24, 108);
  }, []);

  const onFile = async (file: File | undefined): Promise<void> => {
    if (file === undefined) return;
    setPicked(file.name);
    const res = await fetch(`${API}/api/score`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer reticle-demo-token' },
      body: JSON.stringify({ filename: file.name, size: file.size }),
    });
    const data = (await res.json()) as { score?: number };
    setScore('number' === typeof data.score ? String(data.score) : '');
  };

  return (
    <div className="view">
      <div className="panel panel-pad" style={{ maxWidth: 560 }}>
        <h3 data-testid="awkward-heading">Awkward controls</h3>

        <label htmlFor="awkward-file">Attach a file</label>
        <input
          id="awkward-file"
          data-testid="awkward-file"
          type="file"
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
        <output data-testid="awkward-picked">{picked}</output>
        <output data-testid="awkward-score">{score}</output>

        {/* No text, no aria-label, no title: nothing an accessible-name computation can return. */}
        <button data-testid="awkward-icon" onClick={() => setClicks((n) => n + 1)}>
          <svg width="16" height="16" aria-hidden="true" focusable="false">
            <circle cx="8" cy="8" r="7" fill="currentColor" />
          </svg>
        </button>
        <output data-testid="awkward-icon-clicks">{clicks}</output>

        <canvas data-testid="awkward-canvas" ref={canvas} width={240} height={120} />
      </div>
    </div>
  );
}
