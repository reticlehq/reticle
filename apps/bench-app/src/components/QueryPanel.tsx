import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { API_BASE, authToken } from '../lib/api.js';

/**
 * A TanStack Query panel, present so the suite exercises the bug class that only a cache read can
 * witness.
 *
 * Server state is where "the screen is plausible and the network is silent" is not an edge case but
 * the normal failure. A mutation that forgets to invalidate its query leaves the UI rendering the
 * value it fetched earlier — a number that was CORRECT a moment ago, so nothing about it looks wrong
 * — and, crucially, **no request is made**. An outside-in tool watching the network sees silence and
 * calls the page healthy; a screenshot diff against a baseline taken before the mutation sees no
 * change and agrees. The only witness is the cache's own freshness metadata, which is not in the DOM.
 *
 * The panel deliberately renders ONLY the count. There is no list to compare against, so the DOM
 * carries no evidence of staleness and the query cache is the sole source of truth about whether what
 * is on screen came from fresh data.
 */
const QUERY_COUNT_TESTID = 'query-item-count';
const QUERY_ADD_TESTID = 'query-add-item';
const ITEMS_QUERY_KEY = ['items'] as const;

interface ItemsResponse {
  total: number;
}

async function fetchItems(): Promise<ItemsResponse> {
  const res = await fetch(`${API_BASE}/api/items?limit=1`, {
    headers: { authorization: `Bearer ${authToken()}` },
  });
  if (!res.ok) throw new Error(`items ${String(res.status)}`);
  return (await res.json()) as ItemsResponse;
}

export function QueryPanel({ invalidateOnAdd }: { invalidateOnAdd: boolean }): React.ReactElement {
  const client = useQueryClient();
  const items = useQuery({ queryKey: ITEMS_QUERY_KEY, queryFn: fetchItems, staleTime: 60_000 });

  const add = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${API_BASE}/api/items`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${authToken()}` },
        body: JSON.stringify({ name: `item-${String(Date.now())}` }),
      });
      if (!res.ok) throw new Error(`add ${String(res.status)}`);
      return (await res.json()) as { id: number };
    },
    onSuccess: () => {
      // The whole bug, in one branch. Skipping this leaves the cache holding a total the server has
      // already moved past — and because nothing refetches, there is no request for anyone outside
      // the app to notice.
      if (invalidateOnAdd) void client.invalidateQueries({ queryKey: ITEMS_QUERY_KEY });
    },
  });

  return (
    <section className="panel">
      <h3>Items (server state)</h3>
      <p data-testid={QUERY_COUNT_TESTID}>{items.data?.total ?? '—'}</p>
      <button
        type="button"
        data-testid={QUERY_ADD_TESTID}
        onClick={() => add.mutate()}
        disabled={add.isPending}
      >
        Add item
      </button>
    </section>
  );
}
