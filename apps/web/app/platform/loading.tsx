/** Khung xương trong lúc Server Component chờ API — giữ bố cục, không nhảy trang. */
export default function PlatformLoading() {
  return (
    <div aria-busy="true" aria-label="Đang tải">
      <div className="page-head">
        <div>
          <div className="skeleton" style={{ width: 200, height: 28 }} />
          <div className="skeleton mt-8" style={{ width: 280, height: 16 }} />
        </div>
      </div>
      <div className="stats">
        {[0, 1, 2].map((i) => (
          <div key={i} className="skeleton" style={{ height: 112, borderRadius: 14 }} />
        ))}
      </div>
      <div className="card">
        <div className="card-body stack">
          {Array.from({ length: 7 }, (_, i) => (
            <div key={i} className="skeleton" style={{ height: 36 }} />
          ))}
        </div>
      </div>
    </div>
  );
}
