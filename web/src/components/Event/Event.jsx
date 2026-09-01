import { useEffect, useRef } from "react";
import SourceLink from "../SourceLink/SourceLink.jsx";
import styles from "./event.module.css";

function pad(value) {
  return String(value).padStart(2, "0");
}

function formatTimestamp(timestamp) {
  if (!timestamp) return "—";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "—";
  const datePart = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const timePart = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return `${datePart} ${timePart}`;
}

// Only shown within the first hour — past that the absolute timestamp is
// close enough and "N hours ago" stops being useful at a glance.
function formatRelativeTime(timestamp) {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;

  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  return null;
}

export default function Event({ event, onSelect, hovered = false }) {
  const itemRef = useRef(null);

  // The j/k cursor can land on a row that's scrolled out of sight.
  useEffect(() => {
    if (hovered) itemRef.current?.scrollIntoView({ block: "nearest" });
  }, [hovered]);

  const handleKeyDown = (keyEvent) => {
    if (keyEvent.key !== "Enter" && keyEvent.key !== " ") return;
    keyEvent.preventDefault();
    onSelect(event);
  };

  const relativeTime = formatRelativeTime(event.timestamp);
  // Highlighted only while it reads "just now" — the next poll clears it.
  const fresh = relativeTime === "just now";

  return (
    <div
      ref={itemRef}
      className={`${styles.item} ${styles.clickable}${fresh ? ` ${styles.fresh}` : ""}${hovered ? ` ${styles.hovered}` : ""}`}
      role="button"
      tabIndex={0}
      onClick={() => onSelect(event)}
      onKeyDown={handleKeyDown}
    >
      <div className={styles.itemTop}>
        <span className={styles.timestamp}>
          {formatTimestamp(event.timestamp)}
          {relativeTime && <span className={styles.relativeTime}> ({relativeTime})</span>}
        </span>
        <span className={`${styles.eventState} ${styles[event.tone]}`}>{event.outcome}</span>
      </div>
      <div className={styles.title}>
        {/* Which trigger noticed it, since the list mixes all four. */}
        <span className={styles.trigger}>{event.trigger}</span>{" "}
        [{String(event.event).toUpperCase()}] <SourceLink source={event.source} />
      </div>
      {event.detail && <div className={styles.eventDetail}>{event.detail}</div>}
    </div>
  );
}
