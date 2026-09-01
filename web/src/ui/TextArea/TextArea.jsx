import { useRef, useCallback, forwardRef } from 'react';
import styles from './textarea.module.css';

const TextArea = forwardRef(function TextArea({ className, minHeight = 80, style, ...props }, forwardedRef) {
  const localRef = useRef(null);

  // Memoized: a fresh function here would make React detach and re-attach the
  // ref on every render, so a caller's callback ref would run again on each
  // one — turning "do this when the textarea appears" into "do it constantly".
  const setRefs = useCallback(
    (el) => {
      localRef.current = el;
      if (typeof forwardedRef === 'function') forwardedRef(el);
      else if (forwardedRef) forwardedRef.current = el;
    },
    [forwardedRef],
  );

  function onMouseDown(e) {
    e.preventDefault();
    // Measured against the textarea's live bottom edge on every move, rather
    // than a delta from the drag's start: a centered modal re-centers itself
    // as this grows, so a fixed starting point drifts away from the cursor.
    // Reading the actual current edge each time self-corrects for that.
    function onMouseMove(e) {
      const rect = localRef.current.getBoundingClientRect();
      // A CSS max-height (e.g. one keeping this from outgrowing a modal) caps
      // what the browser will actually render. Without reading it here too,
      // continuing to move past that cap piles up a growing, unrendered
      // height request — so the cursor drifts away from the handle instead of
      // just stopping at the limit, same as running past minHeight would.
      const maxHeight = parseFloat(getComputedStyle(localRef.current).maxHeight) || Infinity;
      const newHeight = Math.min(maxHeight, Math.max(minHeight, rect.height + (e.clientY - rect.bottom)));
      localRef.current.style.height = newHeight + 'px';
    }
    function onMouseUp() {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
    }
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }

  return (
    <div className={styles.wrapper}>
      <textarea
        ref={setRefs}
        className={`${styles.textarea}${className ? ` ${className}` : ''}`}
        style={{ minHeight, ...style }}
        {...props}
      />
      <div className={styles.handle} onMouseDown={onMouseDown} />
    </div>
  );
});

export default TextArea;
