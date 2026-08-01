import { useEffect } from 'react';
import styles from './modal.module.css';

export default function Modal({ isOpen, onClose, title, children, closeOnOverlay = false, className }) {
  // Prevent touchmove on the background; allow it on scrollable content
  // (textarea/input/select, or anything that actually scrolls).
  useEffect(() => {
    if (!isOpen) return undefined;
    const isScrollable = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      return (style.overflowY === 'auto' || style.overflowY === 'scroll') && el.scrollHeight > el.clientHeight;
    };
    const allowTags = ['TEXTAREA', 'INPUT', 'SELECT'];
    const handleTouchMove = (event) => {
      let el = event.target;
      while (el && el !== document.body) {
        if (allowTags.includes(el.tagName) || isScrollable(el)) return;
        el = el.parentElement;
      }
      event.preventDefault();
    };
    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';

    return () => {
      document.removeEventListener('touchmove', handleTouchMove);
      document.body.style.overflow = '';
      document.documentElement.style.overflow = '';
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const handleOverlayClick = (event) => {
    if (closeOnOverlay && event.target === event.currentTarget) onClose();
  };

  return (
    <div className={styles.overlay} onClick={handleOverlayClick}>
      <div className={[styles.modal, className].filter(Boolean).join(' ')}>
        <div className={styles.header}>
          {title && <span className={styles.title}>{title}</span>}
          <button className={styles.closeButton} onClick={onClose} disabled={!onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className={styles.content}>{children}</div>
      </div>
    </div>
  );
}
