import { useEffect, useState } from 'react';
import { ActionButton, Modal, TextArea } from '../../ui/index.js';
import { POLL_MS } from '../../pollInterval.js';
import styles from './InfoButton.module.css';

// Polls hooks.json on the same cadence as the status list, but only while the
// modal is actually open — no point refreshing a panel nobody is looking at.
export default function InfoButton() {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return undefined;

    const load = () =>
      fetch('/api/hooks.json')
        .then((res) => {
          if (!res.ok) throw new Error(String(res.status));
          return res.text();
        })
        .then((text) => {
          setContent(text);
          setError(null);
        })
        .catch(() => setError('Could not load hooks.json.'));

    load();
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [open]);

  return (
    <>
      <ActionButton tooltip="hooks.json" ariaLabel="Show hooks.json" onClick={() => setOpen(true)}>
        <svg viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v6" />
          <path d="M12 7.5v.5" />
        </svg>
      </ActionButton>
      <Modal isOpen={open} onClose={() => setOpen(false)} title="hooks.json" closeOnOverlay>
        {error ? (
          <p className={styles.error}>{error}</p>
        ) : (
          <TextArea
            className={styles.code}
            value={content ?? 'Loading…'}
            readOnly
            spellCheck={false}
            style={{ minHeight: 'min(400px, calc(90vh - 100px))', maxHeight: 'calc(90vh - 100px)' }}
          />
        )}
      </Modal>
    </>
  );
}
