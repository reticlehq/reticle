import { useApp, type AckInvite } from '../store/store.js';

/**
 * A failed write that the app acknowledges, beside the defects it must not hide (#2173).
 *
 *  - The store keeps the failed call's HTTP status: a 429 recorded as `status: 429` with a message
 *    that asks the user to try again (silent). The same 429 while the store says `sent: true`
 *    (report `ui-advanced-request-failed`).
 *  - An order that fails with a 500 for the first time, and then shows "Order saved" (report).
 *
 * The two invite buttons use different URLs, so the failure of one never happened before the other.
 */
const API = 'http://localhost:8787/api/ack-pairs';
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const RETRY_MESSAGE = 'Too many invites. Try again in a minute.';
const INVITE_SENT = 'Invitation sent';
const ORDER_SAVED = 'Order saved';

async function sendInvite(path: string): Promise<Response> {
  return fetch(`${API}/${path}`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ email: 'ana@example.com' }),
  });
}

async function inviteWithRetry(): Promise<void> {
  const res = await sendInvite('invite-retry');
  useApp.setState({ ackInvite: { status: res.status, message: RETRY_MESSAGE } });
}

/** The defect, on purpose: the invite failed and the store says it was sent. */
async function inviteClaimed(): Promise<void> {
  await sendInvite('invite-claimed');
  useApp.setState({ ackInvite: { sent: true } });
}

/** The defect, on purpose: the order failed and the page says it was saved. */
async function saveOrder(): Promise<void> {
  await fetch(`${API}/order`, { method: 'POST', headers: JSON_HEADERS, body: '{"sku":"pro"}' });
  useApp.setState({ ackOrder: ORDER_SAVED });
}

function inviteText(invite: AckInvite | null): string {
  if (true === invite?.sent) {
    return INVITE_SENT;
  }
  return invite?.message ?? '';
}

export function AckPairs(): React.ReactElement {
  const invite = useApp((s) => s.ackInvite);
  const order = useApp((s) => s.ackOrder);

  return (
    <div className="view">
      <div className="panel panel-pad" style={{ maxWidth: 560 }}>
        <h3>Invite</h3>
        <button data-testid="ack-pairs-invite-retry" onClick={() => void inviteWithRetry()}>
          Invite with retry
        </button>
        <button data-testid="ack-pairs-invite-claimed" onClick={() => void inviteClaimed()}>
          Invite and claim
        </button>
        <output data-testid="ack-pairs-invite">{inviteText(invite)}</output>
      </div>
      <div className="panel panel-pad" style={{ maxWidth: 560 }}>
        <h3>Order</h3>
        <button data-testid="ack-pairs-order" onClick={() => void saveOrder()}>
          Save order
        </button>
        <output data-testid="ack-pairs-order-status">{order}</output>
      </div>
    </div>
  );
}
