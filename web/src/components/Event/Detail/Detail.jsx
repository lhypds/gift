import { Modal, TextArea } from "@ui/index.js";
import styles from "./detail.module.css";

function formatDuration(ms) {
  if (typeof ms !== "number") return null;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function runStatus(run) {
  if (run.error) return `failed to start — ${run.error}`;
  const parts = [run.signal ? `killed (${run.signal})` : `exit ${run.exit}`];
  const duration = formatDuration(run.ms);
  if (duration) parts.push(duration);
  return parts.join(" · ");
}

export default function Detail({ event, onClose }) {
  const runs = event?.runs ?? [];

  return (
    <Modal isOpen={Boolean(event)} onClose={onClose} closeOnOverlay>
      {runs.length === 0 && <p className={styles.empty}>No hook ran for this event.</p>}
      {runs.map((run, index) => (
        <div key={index} className={styles.run}>
          <div className={styles.runHeader}>
            <span className={styles.hookName}>{run.hook}</span>
            <span className={styles.runState}>{runStatus(run)}</span>
          </div>
          {!run.error && (
            <TextArea
              className={styles.output}
              value={run.output || "(no output)"}
              readOnly
              spellCheck={false}
              style={{ minHeight: "min(420px, 70vh)", maxHeight: "calc(80vh - 140px)" }}
            />
          )}
        </div>
      ))}
    </Modal>
  );
}
