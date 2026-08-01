import { useCallback, useEffect, useRef, useState } from 'react';
import DeliveryItem from './components/DeliveryItem.jsx';
import EmptyState from './components/EmptyState.jsx';
import RefreshButton from './components/RefreshButton.jsx';
import InfoButton from './components/InfoButton.jsx';
import { POLL_MS } from './pollInterval.js';

// Replaces the old <meta http-equiv="refresh" content="30">: only the list
// re-renders, rather than the whole page reloading.

export default function App() {
  const [data, setData] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const cancelledRef = useRef(false);

  const load = useCallback(() => {
    setRefreshing(true);
    return fetch('/api/status')
      .then((res) => res.json())
      .then((json) => {
        if (!cancelledRef.current) setData(json);
      })
      .catch(() => {
        /* transient network error — the next poll tries again */
      })
      .finally(() => {
        if (!cancelledRef.current) setRefreshing(false);
      });
  }, []);

  useEffect(() => {
    cancelledRef.current = false;
    load();
    const id = setInterval(load, POLL_MS);
    return () => {
      cancelledRef.current = true;
      clearInterval(id);
    };
  }, [load]);

  const deliveries = data?.deliveries;

  return (
    <main>
      <div className="page-header">
        <h1>gift</h1>
        <div className="header-actions">
          <InfoButton />
          <RefreshButton onRefresh={load} loading={refreshing} />
        </div>
      </div>

      <section aria-label="Deliveries">
        {deliveries && deliveries.length === 0 && (
          <EmptyState>
            <p>No deliveries.</p>
          </EmptyState>
        )}
        {deliveries && deliveries.length > 0 && (
          <div className="list">
            {deliveries.map((delivery, index) => <DeliveryItem key={index} delivery={delivery} />)}
          </div>
        )}
      </section>
    </main>
  );
}
