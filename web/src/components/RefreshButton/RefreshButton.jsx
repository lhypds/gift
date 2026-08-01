import { ActionButton } from '../../ui/index.js';

export default function RefreshButton({ onRefresh, loading }) {
  return (
    <ActionButton
      tooltip={loading ? 'Refreshing…' : 'Refresh'}
      ariaLabel="Refresh"
      disabled={loading}
      onClick={onRefresh}
    >
      <svg viewBox="0 0 24 24">
        <path d="M20 12a8 8 0 1 1-2.34-5.66" />
        <path d="M20 4v5h-5" />
      </svg>
    </ActionButton>
  );
}
