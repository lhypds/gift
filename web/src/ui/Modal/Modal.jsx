import { useEffect, useRef } from 'react';
import styles from './modal.module.css';

export default function Modal({ isOpen, onClose, title, children, closeOnOverlay = false, className }) {
  // The browser's "click" fires on the nearest common ancestor of the
  // mousedown and mouseup targets — so dragging a resize handle (e.g. inside
  // TextArea) past the modal's edge ends the gesture over the overlay, and a
  // naive target check on click alone would misread that as a dismiss click.
  // Requiring the press to have *also* started on the overlay rules that out.
  const pressedOnOverlay = useRef(false);
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

  const handleOverlayMouseDown = (event) => {
    pressedOnOverlay.current = event.target === event.currentTarget;
  };

  const handleOverlayClick = (event) => {
    if (closeOnOverlay && pressedOnOverlay.current && event.target === event.currentTarget) onClose();
  };

  return (
    <div className={styles.overlay} onMouseDown={handleOverlayMouseDown} onClick={handleOverlayClick}>
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
