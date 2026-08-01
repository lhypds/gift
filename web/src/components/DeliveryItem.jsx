import RepoLink from './RepoLink.jsx';

export default function DeliveryItem({ delivery }) {
  return (
    <div className="item">
      <div className="info">
        <div className="title">{delivery.event}</div>
        <div className="subtitle">
          <RepoLink repo={delivery.repo} /> · {delivery.id} · {delivery.timestamp}
        </div>
      </div>
      <div className="meta">
        <span className={`delivery-state ${delivery.tone}`}>{delivery.outcome}</span>
        {delivery.detail && <span className="delivery-detail">{delivery.detail}</span>}
      </div>
    </div>
  );
}
