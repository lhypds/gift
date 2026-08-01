import styles from './EmptyState.module.css';

export default function EmptyState({ children }) {
  return <div className={styles.emptyState}>{children}</div>;
}
