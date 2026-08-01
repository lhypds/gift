import RepoLink from './RepoLink.jsx';

export default function DeliveryItem({ delivery }) {
  return (
    <div className="item">
      <div className="item-top">
        <span className="timestamp">{delivery.timestamp}</span>
        <span className={`delivery-state ${delivery.tone}`}>{delivery.outcome}</span>
      </div>
      <div className="title">
        [{delivery.event.toUpperCase()}] <RepoLink repo={delivery.repo} />
      </div>
      {delivery.detail && <div className="delivery-detail">{delivery.detail}</div>}
    </div>
  );
}
