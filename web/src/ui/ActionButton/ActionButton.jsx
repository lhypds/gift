import React from 'react';
import styles from './action.module.css';

export default function ActionButton({ tooltip, ariaLabel, onClick, disabled, children }) {
  const icon = React.Children.only(children);
  return (
    <button
      type="button"
      className={styles.actionButton}
      data-tooltip={tooltip}
      aria-label={ariaLabel || tooltip}
      disabled={disabled}
      onClick={onClick}
    >
      {React.cloneElement(icon, { className: styles.icon })}
    </button>
  );
}
