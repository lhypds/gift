import { useCallback } from "react";
import { Modal, TextArea } from "@ui/index.js";
import styles from "./detail.module.css";

// Hooks run without a TTY, so most tools drop their color on their own — but
// anything that forces it (FORCE_COLOR, a --color flag) would land here as
// literal "←[32m" noise, since a textarea renders escapes rather than obeying
// them. Matches the CSI form colors use, OSC strings (terminated by BEL or
// ST), and the bare two-character escapes, then drops them all.
const ANSI_ESCAPE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][\s\S]*?(?:\x07|\x1b\\)|[@-_])/g;

function plainText(output) {
  return output.replace(ANSI_ESCAPE, "");
}

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
  // Output is a log, so the interesting part is the end. Scrolling from the
  // ref callback lands it at the bottom before the modal is ever painted;
  // stable identity keeps it a mount-time move, so the list refreshing
  // underneath (App re-finds the selected event on every poll) can't yank the
  // view back down while it's being read.
  const pinToBottom = useCallback((el) => {
    if (el) el.scrollTop = el.scrollHeight;
  }, []);
  // One delivery can fan out to several hooks, so no single hook owns the
  // title: it counts the runs, and every run carries its own name above its
  // message or output — the same shape whether one hook ran or five did.
  const title = runs.length > 0 ? `${runs.length} hook run${runs.length === 1 ? "" : "s"}` : undefined;

  return (
    <Modal isOpen={Boolean(event)} onClose={onClose} title={title} closeOnOverlay className={styles.wide}>
      {runs.length === 0 && <p className={styles.empty}>No hook ran for this event.</p>}
      {runs.map((run, index) => (
        <div key={index} className={styles.run}>
          <div className={styles.runHeader}>
            <div className={styles.hookName}>{run.hook}</div>
            <div className={styles.runState}>{runStatus(run)}</div>
          </div>
          {!run.error && (
            <TextArea
              ref={pinToBottom}
              className={styles.output}
              value={run.output ? plainText(run.output) : "(no output)"}
              readOnly
              spellCheck={false}
              wrap="off"
              style={{ minHeight: "var(--output-height)", maxHeight: "var(--output-max-height)" }}
            />
          )}
        </div>
      ))}
    </Modal>
  );
}
