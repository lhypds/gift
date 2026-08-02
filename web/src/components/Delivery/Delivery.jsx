import RepoLink from "../RepoLink/RepoLink.jsx";
import styles from "./delivery.module.css";

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

export default function Delivery({ delivery, onSelect }) {
  const handleKeyDown = (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onSelect(delivery);
  };

  return (
    <div
      className={`${styles.item} ${styles.clickable}`}
      role="button"
      tabIndex={0}
      onClick={() => onSelect(delivery)}
      onKeyDown={handleKeyDown}
    >
      <div className={styles.itemTop}>
        <span className={styles.timestamp}>{formatTimestamp(delivery.timestamp)}</span>
        <span className={`${styles.deliveryState} ${styles[delivery.tone]}`}>{delivery.outcome}</span>
      </div>
      <div className={styles.title}>
        [{delivery.event.toUpperCase()}] <RepoLink repo={delivery.repo} />
      </div>
      {delivery.detail && <div className={styles.deliveryDetail}>{delivery.detail}</div>}
    </div>
  );
}
