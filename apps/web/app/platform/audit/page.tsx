import type { Metadata } from 'next';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, FileClock } from 'lucide-react';
import type { Paged, PlatformAuditRow } from '@pt/contracts';
import { Card, EmptyState, PageHeader } from '../../../components/ui';
import { apiFetch, requireSession } from '../../../lib/session';
import { AuditTable } from '../audit-table';

export const metadata: Metadata = { title: 'Nhật ký thao tác' };

/**
 * Nhật ký CHỈ GHI THÊM: role app_platform không có quyền UPDATE/DELETE bảng
 * này, nên kể cả quản trị SUPER cũng không xoá được dấu vết của mình.
 */
export default async function PlatformAudit({
  searchParams,
}: {
  searchParams: Promise<{ tenantId?: string; page?: string }>;
}) {
  const session = await requireSession();
  const { tenantId, page } = await searchParams;
  const trang = Math.max(1, Number(page) || 1);

  const qs = new URLSearchParams({ page: String(trang) });
  if (tenantId && /^[0-9a-f-]{36}$/i.test(tenantId)) qs.set('tenantId', tenantId);
  const data = await apiFetch<Paged<PlatformAuditRow>>(`/platform/audit?${qs}`, session);

  const soTrang = Math.max(1, Math.ceil(data.total / data.size));
  const link = (p: number) => {
    const x = new URLSearchParams({ page: String(p) });
    if (qs.get('tenantId')) x.set('tenantId', qs.get('tenantId')!);
    return `/platform/audit?${x}`;
  };
  const tenPhong = qs.get('tenantId') ? data.items.find((a) => a.tenantId === qs.get('tenantId'))?.tenantName : null;

  return (
    <>
      <PageHeader
        title="Nhật ký thao tác"
        sub={
          <>
            {data.total.toLocaleString('vi-VN')} dòng{tenPhong ? ` · phòng ${tenPhong}` : ''} · chỉ ghi thêm, không ai sửa hay xoá được
            {qs.get('tenantId') && (
              <>
                {' · '}
                <Link href="/platform/audit" className="link">
                  Bỏ lọc
                </Link>
              </>
            )}
          </>
        }
      />

      <Card
        flush
        footer={
          soTrang > 1 && (
            <div className="row">
              <span className="small muted">
                Trang {trang}/{soTrang}
              </span>
              <div className="row-start" style={{ gap: 8 }}>
                {trang > 1 && (
                  <Link href={link(trang - 1)} className="btn btn-secondary btn-sm">
                    <ChevronLeft size={14} /> Mới hơn
                  </Link>
                )}
                {trang < soTrang && (
                  <Link href={link(trang + 1)} className="btn btn-secondary btn-sm">
                    Cũ hơn <ChevronRight size={14} />
                  </Link>
                )}
              </div>
            </div>
          )
        }
      >
        {data.items.length === 0 ? (
          <EmptyState icon={FileClock} title="Chưa có thao tác nào" />
        ) : (
          <AuditTable rows={data.items} showTenant />
        )}
      </Card>
    </>
  );
}
