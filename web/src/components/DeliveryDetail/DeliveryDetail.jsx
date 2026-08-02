import { Modal, TextArea } from "../../ui/index.js";
import RepoLink from "../RepoLink/RepoLink.jsx";
import styles from "./deliveryDetail.module.css";

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

export default function DeliveryDetail({ delivery, onClose }) {
  const runs = delivery?.runs ?? [];

  return (
    <Modal
      isOpen={Boolean(delivery)}
      onClose={onClose}
      closeOnOverlay
      title={
        delivery && (
          <>
            [{delivery.event.toUpperCase()}] <RepoLink repo={delivery.repo} />
          </>
        )
      }
    >
      {runs.length === 0 && <p className={styles.empty}>No hook output for this delivery.</p>}
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
              style={{ minHeight: "min(240px, 50vh)", maxHeight: "calc(80vh - 140px)" }}
            />
          )}
        </div>
      ))}
    </Modal>
  );
}
