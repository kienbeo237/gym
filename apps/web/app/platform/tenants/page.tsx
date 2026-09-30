import type { Metadata } from 'next';
import Link from 'next/link';
import { Building2, Plus, Search } from 'lucide-react';
import type { PlatformTenantRow } from '@pt/contracts';
import { Badge, Card, EmptyState, PageHeader } from '../../../components/ui';
import { UsageBar } from '../../../components/saas';
import { ngayISO, vnd } from '../../../lib/format';
import { TRANG_THAI_PHONG, TRANG_THAI_THUE_BAO } from '../../../lib/labels';
import { apiFetch, duCap, requireSession } from '../../../lib/session';

export const metadata: Metadata = { title: 'Phòng tập' };

const LOC = [
  { key: '', label: 'Tất cả' },
  { key: 'TRIAL', label: 'Dùng thử' },
  { key: 'ACTIVE', label: 'Hoạt động' },
  { key: 'PAST_DUE', label: 'Quá hạn' },
  { key: 'SUSPENDED', label: 'Bị khoá' },
  { key: 'CLOSED', label: 'Đã đóng' },
];

export default async function PlatformTenants({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  const session = await requireSession();
  const { q, status } = await searchParams;
  const loc = LOC.some((l) => l.key === status) ? (status ?? '') : '';

  const qs = new URLSearchParams();
  if (q) qs.set('q', q);
  if (loc) qs.set('status', loc);
  const rows = await apiFetch<PlatformTenantRow[]>(`/platform/tenants?${qs}`, session);

  const link = (s: string) => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (s) p.set('status', s);
    const x = p.toString();
    return x ? `/platform/tenants?${x}` : '/platform/tenants';
  };

  return (
    <>
      <PageHeader
        title="Phòng tập"
        sub={`${rows.length} phòng${loc ? ` · ${TRANG_THAI_PHONG[loc]?.text.toLowerCase()}` : ''}`}
        actions={
          duCap(session, 'OPS') && (
            <Link href="/platform/tenants/new" className="btn btn-primary">
              <Plus size={16} /> Tạo phòng tập
            </Link>
          )
        }
      />

      <Card flush>
        <div className="toolbar">
          <nav className="segmented" aria-label="Lọc theo trạng thái">
            {LOC.map((l) => (
              <Link key={l.key} href={link(l.key)} aria-current={loc === l.key ? 'page' : undefined}>
                {l.label}
              </Link>
            ))}
          </nav>
          <form className="search" role="search">
            {loc && <input type="hidden" name="status" value={loc} />}
            <label className="input-wrap">
              <span className="sr-only">Tìm phòng tập</span>
              <Search size={17} />
              <input className="input" name="q" defaultValue={q ?? ''} placeholder="Tên phòng hoặc tên miền" />
            </label>
          </form>
        </div>

        {rows.length === 0 ? (
          <EmptyState icon={Building2} title="Không có phòng nào" text="Không phòng tập nào khớp bộ lọc đang chọn." />
        ) : (
          <div className="table-wrap">
            <table className="table table-flush">
              <thead>
                <tr>
                  <th>Phòng tập</th>
                  <th>Gói</th>
                  <th>Đã trả tới</th>
                  <th>Sử dụng</th>
                  <th className="num">Chờ thu</th>
                  <th>Trạng thái</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <Link href={`/platform/tenants/${t.id}`} className="cell-main link">
                        {t.name}
                      </Link>
                      <div className="cell-sub mono">{t.slug}</div>
                    </td>
                    <td>
                      <div className="cell-main">{t.planName}</div>
                      <div className="cell-sub">{TRANG_THAI_THUE_BAO[t.subscriptionStatus]?.text ?? t.subscriptionStatus}</div>
                    </td>
                    <td className="nowrap tabular">{ngayISO(t.paidThrough)}</td>
                    <td>
                      <div className="usage-cell">
                        <UsageBar compact label="HV" m={t.usage.members} />
                        <UsageBar compact label="HLV" m={t.usage.trainers} />
                        <UsageBar compact label="Tin" m={t.usage.messages} />
                      </div>
                    </td>
                    <td className="num tabular">{t.openAmount > 0 ? vnd(t.openAmount) : '—'}</td>
                    <td>
                      <Badge tone={TRANG_THAI_PHONG[t.status]?.tone} dot>
                        {TRANG_THAI_PHONG[t.status]?.text ?? t.status}
                      </Badge>
                      {t.statusNote && <div className="cell-sub">{t.statusNote}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
