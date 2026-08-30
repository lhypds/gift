import { useCallback, useEffect, useRef, useState } from 'react';
import Event from './components/Event/Event.jsx';
import Detail from './components/Event/Detail/Detail.jsx';
import EmptyState from './components/EmptyState/EmptyState.jsx';
import RefreshButton from './components/RefreshButton/RefreshButton.jsx';
import InfoButton from './components/InfoButton/InfoButton.jsx';
import { POLL_MS } from './pollInterval.js';

// One list for all four triggers, newest first: a webhook delivery, a clipboard
// change, a page that came back different and a file that was written are the
// same kind of thing here — something happened, and these hooks ran.

export default function App() {
  const [data, setData] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState(null);
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

  const events = data?.events;
  // Re-read the selected event from the latest poll, so output that's still
  // streaming in appears in an already-open modal. An event with no id (the
  // "No id" placeholder) can't be matched back up reliably, so it just keeps
  // showing the snapshot taken at click time.
  const selectedEvent = selected
    ? (events?.find((e) => e.id === selected.id && e.id !== 'No id') ?? selected)
    : null;

  return (
    <main>
      <div className="page-header">
        <h1>gift</h1>
        <div className="header-actions">
          <InfoButton />
          <RefreshButton onRefresh={load} loading={refreshing} />
        </div>
      </div>

      <section aria-label="Events">
        {events && events.length === 0 && (
          <EmptyState>
            <p>Nothing has happened yet.</p>
          </EmptyState>
        )}
        {events && events.length > 0 && (
          <div className="list">
            {events.map((event, index) => (
              <Event key={index} event={event} onSelect={setSelected} />
            ))}
          </div>
        )}
      </section>

      <Detail event={selectedEvent} onClose={() => setSelected(null)} />
    </main>
  );
}
