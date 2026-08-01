import RepoLink from '../RepoLink/RepoLink.jsx';
import styles from './DeliveryItem.module.css';

export default function DeliveryItem({ delivery }) {
  return (
    <div className={styles.item}>
      <div className={styles.itemTop}>
        <span className={styles.timestamp}>{delivery.timestamp}</span>
        <span className={`${styles.deliveryState} ${styles[delivery.tone]}`}>{delivery.outcome}</span>
      </div>
      <div className={styles.title}>
        [{delivery.event.toUpperCase()}] <RepoLink repo={delivery.repo} />
      </div>
      {delivery.detail && <div className={styles.deliveryDetail}>{delivery.detail}</div>}
    </div>
  );
}
