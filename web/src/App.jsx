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
  const [cursor, setCursor] = useState(null);
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

  // Vim-style list navigation: j starts at the top, j/k move, Enter or Space
  // opens, Space closes again. Inert while a real control has focus so typing
  // or the items' own Enter/Space handling doesn't collide with it.
  useEffect(() => {
    const handleKeyDown = (keyEvent) => {
      if (keyEvent.metaKey || keyEvent.ctrlKey || keyEvent.altKey) return;
      if (selected) {
        // A row opened by click keeps focus, so this can't use the full
        // control guard below: the row's own Space handler re-selects, but
        // this close runs in the same batch and wins.
        if (keyEvent.key === ' ' && !keyEvent.target.closest?.('input, textarea, select')) {
          keyEvent.preventDefault();
          setSelected(null);
        }
        return;
      }
      if (keyEvent.target.closest?.('input, textarea, select, button, a, [role="button"]')) return;
      const count = events?.length ?? 0;
      if (count === 0) return;

      if (keyEvent.key === 'j') {
        keyEvent.preventDefault();
        setCursor((c) => (c === null ? 0 : Math.min(c + 1, count - 1)));
      } else if (keyEvent.key === 'k') {
        keyEvent.preventDefault();
        setCursor((c) => (c === null ? 0 : Math.max(c - 1, 0)));
      } else if ((keyEvent.key === 'Enter' || keyEvent.key === ' ') && cursor !== null) {
        keyEvent.preventDefault();
        setSelected(events[Math.min(cursor, count - 1)]);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [events, selected, cursor]);

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
              <Event key={index} event={event} onSelect={setSelected} hovered={index === cursor} />
            ))}
          </div>
        )}
      </section>

      <Detail event={selectedEvent} onClose={() => setSelected(null)} />
    </main>
  );
}
