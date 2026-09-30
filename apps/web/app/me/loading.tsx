export default function MeLoading() {
  return (
    <div aria-busy="true" aria-label="Đang tải" className="stack">
      <div className="skeleton" style={{ width: 180, height: 26 }} />
      <div className="skeleton" style={{ width: 240, height: 16 }} />
      <div className="skeleton mt-8" style={{ height: 150, borderRadius: 20 }} />
      {[0, 1, 2].map((i) => (
        <div key={i} className="skeleton" style={{ height: 90, borderRadius: 14 }} />
      ))}
    </div>
  );
}
