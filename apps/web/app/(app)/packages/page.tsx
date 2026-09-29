import type { Paged, PackageSummary } from '@pt/contracts';
import { apiFetch, requireSession } from '../../../lib/session';

const vnd = (n: number) => n.toLocaleString('vi-VN');

const TEN_LOAI: Record<PackageSummary['kind'], string> = {
  PT: 'Tập cùng huấn luyện viên',
  GYM: 'Thẻ tập tự do',
  COMBO: 'Gói kết hợp',
  CLASS: 'Lớp nhóm',
};

export default async function PackagesPage({
  searchParams,
}: {
  searchParams: Promise<{ all?: string }>;
}) {
  const session = await requireSession();
  const { all } = await searchParams;
  const data = await apiFetch<Paged<PackageSummary>>(
    `/packages?size=50${all === '1' ? '&includeInactive=true' : ''}`,
    session,
  );

  return (
    <main>
      <header style={S.header}>
        <div>
          <h1 style={S.h1}>Gói tập</h1>
          <p style={S.sub}>{data.total} gói</p>
        </div>
        <a href={all === '1' ? '/packages' : '/packages?all=1'} style={S.toggle}>
          {all === '1' ? 'Chỉ gói đang bán' : 'Hiện cả gói ngừng bán'}
        </a>
      </header>

      <div style={S.grid}>
        {data.items.map((p) => (
          <article key={p.id} style={{ ...S.card, ...(p.isActive ? {} : S.cardOff) }}>
            <div style={S.cardTop}>
              <div>
                <h2 style={S.name}>{p.name}</h2>
                <p style={S.kind}>
                  {TEN_LOAI[p.kind]} · mã {p.code}
                </p>
              </div>
              {!p.isActive && <span style={S.badgeOff}>Ngừng bán</span>}
            </div>

            <div style={S.priceRow}>
              <strong style={S.price}>{vnd(p.price)} ₫</strong>
              <span style={S.perSession}>{vnd(p.pricePerSession)} ₫/buổi</span>
            </div>

            <dl style={S.meta}>
              <div style={S.metaRow}>
                <dt style={S.dt}>Số buổi</dt>
                <dd style={S.dd}>{p.sessions}</dd>
              </div>
              <div style={S.metaRow}>
                <dt style={S.dt}>Hạn dùng</dt>
                <dd style={S.dd}>{p.validDays} ngày</dd>
              </div>
              <div style={S.metaRow}>
                <dt style={S.dt}>Huỷ muộn</dt>
                <dd style={S.dd}>
                  trước {p.effectivePolicy.lateCancelHours} giờ
                  {p.effectivePolicy.lateCancelDeducts ? ' · trễ hơn thì trừ buổi' : ' · không trừ buổi'}
                </dd>
              </div>
              <div style={S.metaRow}>
                <dt style={S.dt}>Vắng không báo</dt>
                <dd style={S.dd}>{p.effectivePolicy.noShowDeducts ? 'trừ buổi' : 'không trừ buổi'}</dd>
              </div>
              <div style={S.metaRow}>
                <dt style={S.dt}>Đã bán</dt>
                <dd style={S.dd}>{p.soldCount} hợp đồng</dd>
              </div>
            </dl>

            {/* Nói rõ ô nào đang theo mặc định của phòng. Không có dòng này thì
                người dùng sửa chính sách chung mà không biết gói nào bị ảnh
                hưởng, gói nào không. */}
            {p.effectivePolicy.inheritedFields.length > 0 && (
              <p style={S.inherit}>
                {p.effectivePolicy.inheritedFields.length === 3
                  ? 'Toàn bộ chính sách theo mặc định của phòng tập'
                  : `${p.effectivePolicy.inheritedFields.length} mục theo mặc định của phòng tập`}
              </p>
            )}
          </article>
        ))}
      </div>

      {data.items.length === 0 && <p style={S.empty}>Chưa có gói tập nào.</p>}
    </main>
  );
}

const S: Record<string, React.CSSProperties> = {
  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
    gap: 16, marginBottom: 20, flexWrap: 'wrap',
  },
  h1: { margin: 0, fontSize: 24 },
  sub: { margin: '4px 0 0', fontSize: 13, color: '#8b93a7' },
  toggle: { fontSize: 13, color: '#93c5fd', textDecoration: 'none' },
  grid: {
    display: 'grid', gap: 14,
    gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
  },
  card: {
    background: '#171a21', border: '1px solid #262b36', borderRadius: 12,
    padding: 18, display: 'flex', flexDirection: 'column', gap: 12,
  },
  cardOff: { opacity: 0.55 },
  cardTop: { display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start' },
  name: { margin: 0, fontSize: 16 },
  kind: { margin: '3px 0 0', fontSize: 12, color: '#8b93a7' },
  priceRow: { display: 'flex', alignItems: 'baseline', gap: 10 },
  price: { fontSize: 22, color: '#f2f4f8' },
  perSession: { fontSize: 12, color: '#8b93a7' },
  meta: { margin: 0, display: 'flex', flexDirection: 'column', gap: 5 },
  metaRow: { display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 13 },
  dt: { margin: 0, color: '#8b93a7' },
  dd: { margin: 0, textAlign: 'right' },
  inherit: {
    margin: 0, fontSize: 11, color: '#6b7488', borderTop: '1px solid #20242e', paddingTop: 10,
  },
  badgeOff: {
    fontSize: 11, padding: '2px 8px', borderRadius: 999, whiteSpace: 'nowrap',
    background: '#2a2028', color: '#d1a3b0', border: '1px solid #45303a',
  },
  empty: { color: '#8b93a7', fontSize: 14 },
};
