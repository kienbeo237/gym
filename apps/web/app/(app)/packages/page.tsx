import type { Metadata } from 'next';
import Link from 'next/link';
import { Info, Package, PackagePlus } from 'lucide-react';
import type { Paged, PackageSummary } from '@pt/contracts';
import { Badge, EmptyState, PageHeader, type Tone } from '../../../components/ui';
import { vnd } from '../../../lib/format';
import { apiFetch, requireSession } from '../../../lib/session';

export const metadata: Metadata = { title: 'Gói tập' };

const LOAI: Record<PackageSummary['kind'], { text: string; tone: Tone }> = {
  PT: { text: 'Tập cùng HLV', tone: 'primary' },
  GYM: { text: 'Thẻ tập tự do', tone: 'info' },
  COMBO: { text: 'Gói kết hợp', tone: 'success' },
  CLASS: { text: 'Lớp nhóm', tone: 'warning' },
};

export default async function PackagesPage({
  searchParams,
}: {
  searchParams: Promise<{ all?: string }>;
}) {
  const session = await requireSession();
  const { all } = await searchParams;
  const laQuanLy = session.roles.some((r) => r === 'OWNER' || r === 'ADMIN');
  const data = await apiFetch<Paged<PackageSummary>>(
    `/packages?size=50${all === '1' ? '&includeInactive=true' : ''}`,
    session,
  );

  return (
    <>
      <PageHeader
        title="Gói tập"
        sub={`${data.total} gói ${all === '1' ? 'trong danh mục' : 'đang bán'}`}
        actions={
          <>
            <nav className="segmented" aria-label="Lọc gói tập">
              <Link href="/packages" aria-current={all !== '1' ? 'page' : undefined}>
                Đang bán
              </Link>
              <Link href="/packages?all=1" aria-current={all === '1' ? 'page' : undefined}>
                Tất cả
              </Link>
            </nav>
            {laQuanLy && (
              <Link href="/packages/new" className="btn btn-primary">
                <PackagePlus size={16} /> Thêm gói
              </Link>
            )}
          </>
        }
      />

      {data.items.length === 0 ? (
        <div className="card">
          <EmptyState icon={Package} title="Chưa có gói tập nào" />
        </div>
      ) : (
        <div className="grid-cards">
          {data.items.map((p) => {
            const loai = LOAI[p.kind];
            return (
              <article key={p.id} className="card pkg" data-inactive={!p.isActive}>
                <div className="pkg-head">
                  <div>
                    <h2 className="pkg-name">
                      {laQuanLy ? (
                        <Link href={`/packages/${p.id}`} className="link">
                          {p.name}
                        </Link>
                      ) : (
                        p.name
                      )}
                    </h2>
                    <p className="cell-sub">Mã {p.code}</p>
                  </div>
                  {p.isActive ? <Badge tone={loai.tone}>{loai.text}</Badge> : <Badge>Ngừng bán</Badge>}
                </div>

                <div className="pkg-price">
                  <strong>{vnd(p.price)} ₫</strong>
                  <span className="muted small">
                    {p.sessions} buổi · {vnd(p.pricePerSession)} ₫/buổi
                  </span>
                </div>

                {p.description && <p className="small muted" style={{ margin: 0 }}>{p.description}</p>}

                <dl className="dl">
                  <div>
                    <dt>Hạn dùng</dt>
                    <dd>{p.validDays} ngày</dd>
                  </div>
                  <div>
                    <dt>Huỷ muộn</dt>
                    <dd>
                      trước {p.effectivePolicy.lateCancelHours} giờ
                      {p.effectivePolicy.lateCancelDeducts ? (
                        <span className="text-warning"> · trễ hơn thì trừ buổi</span>
                      ) : (
                        ' · không trừ buổi'
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Vắng không báo</dt>
                    <dd className={p.effectivePolicy.noShowDeducts ? 'text-warning' : undefined}>
                      {p.effectivePolicy.noShowDeducts ? 'trừ buổi' : 'không trừ buổi'}
                    </dd>
                  </div>
                  <div>
                    <dt>Đã bán</dt>
                    <dd>{p.soldCount} hợp đồng</dd>
                  </div>
                </dl>

                {/* Nói rõ ô nào đang theo mặc định của phòng. Không có dòng này thì
                    người dùng sửa chính sách chung mà không biết gói nào bị ảnh
                    hưởng, gói nào không. */}
                {p.effectivePolicy.inheritedFields.length > 0 && (
                  <p className="pkg-foot">
                    <Info size={13} />
                    {p.effectivePolicy.inheritedFields.length === 3
                      ? 'Toàn bộ chính sách theo mặc định của phòng tập'
                      : `${p.effectivePolicy.inheritedFields.length} mục theo mặc định của phòng tập`}
                  </p>
                )}
              </article>
            );
          })}
        </div>
      )}
    </>
  );
}
