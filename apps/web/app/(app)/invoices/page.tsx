import Link from 'next/link';
import type { InvoiceSummary, Paged } from '@pt/contracts';
import { apiFetch, requireSession } from '../../../lib/session';

const vnd = (n: number) => n.toLocaleString('vi-VN');

const NHAN_TRANG_THAI: Record<string, { text: string; style: 'ok' | 'warn' | 'off' | 'due' }> = {
  DRAFT: { text: 'Nháp', style: 'off' },
  OPEN: { text: 'Chưa thu', style: 'due' },
  PARTIALLY_PAID: { text: 'Thu một phần', style: 'warn' },
  PAID: { text: 'Đã thu đủ', style: 'ok' },
  VOID: { text: 'Đã huỷ', style: 'off' },
  REFUNDED: { text: 'Đã hoàn tiền', style: 'off' },
};

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ loc?: string }>;
}) {
  const session = await requireSession();
  const { loc } = await searchParams;

  const qs =
    loc === 'no' ? '&unpaidOnly=true' : loc === 'quahan' ? '&overdueOnly=true&unpaidOnly=true' : '';
  const data = await apiFetch<Paged<InvoiceSummary>>(`/invoices?size=50${qs}`, session);

  const tongPhaiThu = data.items.reduce((s, i) => s + Math.max(0, i.outstanding), 0);
  const soQuaHan = data.items.filter((i) => i.overdueCount > 0).length;

  const tabs = [
    { key: '', label: 'Tất cả' },
    { key: 'no', label: 'Còn nợ' },
    { key: 'quahan', label: 'Quá hạn' },
  ];

  return (
    <main>
      <header style={S.header}>
        <div>
          <h1 style={S.h1}>Hoá đơn</h1>
          <p style={S.sub}>{data.total} hoá đơn</p>
        </div>
        <div style={S.tiles}>
          <div style={S.tile}>
            <span style={S.tileLabel}>Còn phải thu</span>
            <strong style={S.tileValue}>{vnd(tongPhaiThu)} ₫</strong>
            <span style={S.tileHint}>trên trang này</span>
          </div>
          {soQuaHan > 0 && (
            <div style={{ ...S.tile, borderColor: '#5a2d33' }}>
              <span style={S.tileLabel}>Có đợt quá hạn</span>
              <strong style={{ ...S.tileValue, color: '#f87171' }}>{soQuaHan}</strong>
              <span style={S.tileHint}>hoá đơn</span>
            </div>
          )}
        </div>
      </header>

      <div style={S.tabs}>
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={t.key ? `/invoices?loc=${t.key}` : '/invoices'}
            style={{ ...S.tab, ...((loc ?? '') === t.key ? S.tabOn : {}) }}
          >
            {t.label}
          </Link>
        ))}
      </div>

      <table style={S.table}>
        <thead>
          <tr>
            <th style={S.th}>Số hoá đơn</th>
            <th style={S.th}>Hội viên</th>
            <th style={S.th}>Ngày lập</th>
            <th style={{ ...S.th, textAlign: 'right' }}>Phải thu</th>
            <th style={{ ...S.th, textAlign: 'right' }}>Đã thu</th>
            <th style={{ ...S.th, textAlign: 'right' }}>Còn lại</th>
            <th style={S.th}>Trả góp</th>
            <th style={S.th}>Trạng thái</th>
          </tr>
        </thead>
        <tbody>
          {data.items.map((inv) => {
            const nhan = NHAN_TRANG_THAI[inv.status] ?? { text: inv.status, style: 'off' as const };
            return (
              <tr key={inv.id}>
                <td style={S.td}>
                  <Link href={`/invoices/${inv.id}`} style={S.link}>
                    {inv.code}
                  </Link>
                </td>
                <td style={S.td}>
                  {inv.memberName}
                  <div style={S.muted}>{inv.memberCode}</div>
                </td>
                <td style={S.td}>
                  {new Date(inv.issuedAt).toLocaleDateString('vi-VN', {
                    timeZone: 'Asia/Ho_Chi_Minh',
                  })}
                </td>
                <td style={{ ...S.td, textAlign: 'right' }}>{vnd(inv.totalAmount)}</td>
                <td style={{ ...S.td, textAlign: 'right' }}>{vnd(inv.paidAmount)}</td>
                <td style={{ ...S.td, textAlign: 'right', fontWeight: 600 }}>
                  {inv.outstanding > 0 ? vnd(inv.outstanding) : '—'}
                </td>
                <td style={S.td}>
                  {inv.isInstallment ? (
                    <>
                      {/* Ngày tới hạn là thứ lễ tân cần thấy ngay, không phải
                          chỉ biết "có trả góp". */}
                      {inv.nextDueDate ? (
                        <span style={inv.overdueCount > 0 ? S.late : undefined}>
                          {inv.overdueCount > 0 ? `quá hạn ${inv.overdueCount} đợt` : `đến hạn ${inv.nextDueDate}`}
                        </span>
                      ) : (
                        'đã xong'
                      )}
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                <td style={S.td}>
                  <span style={S.badge[nhan.style]}>{nhan.text}</span>
                </td>
              </tr>
            );
          })}
          {data.items.length === 0 && (
            <tr>
              <td style={{ ...S.td, color: '#8b93a7' }} colSpan={8}>
                Không có hoá đơn nào khớp bộ lọc.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </main>
  );
}

const badge = (bg: string, fg: string, bd: string): React.CSSProperties => ({
  fontSize: 12, padding: '2px 8px', borderRadius: 999, background: bg, color: fg,
  border: `1px solid ${bd}`, whiteSpace: 'nowrap',
});

const S = {
  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
    gap: 16, marginBottom: 16, flexWrap: 'wrap',
  } as React.CSSProperties,
  h1: { margin: 0, fontSize: 24 } as React.CSSProperties,
  sub: { margin: '4px 0 0', fontSize: 13, color: '#8b93a7' } as React.CSSProperties,
  tiles: { display: 'flex', gap: 12 } as React.CSSProperties,
  tile: {
    display: 'flex', flexDirection: 'column', gap: 2, padding: '10px 16px',
    background: '#171a21', border: '1px solid #262b36', borderRadius: 10, minWidth: 150,
  } as React.CSSProperties,
  tileLabel: {
    fontSize: 11, color: '#8b93a7', textTransform: 'uppercase', letterSpacing: 0.4,
  } as React.CSSProperties,
  tileValue: { fontSize: 18 } as React.CSSProperties,
  tileHint: { fontSize: 11, color: '#6b7488' } as React.CSSProperties,
  tabs: { display: 'flex', gap: 4, marginBottom: 16 } as React.CSSProperties,
  tab: {
    padding: '6px 13px', borderRadius: 7, fontSize: 13, textDecoration: 'none',
    color: '#8b93a7', border: '1px solid #262b36',
  } as React.CSSProperties,
  tabOn: { background: '#262b36', color: '#f2f4f8', fontWeight: 600 } as React.CSSProperties,
  table: {
    width: '100%', borderCollapse: 'collapse', background: '#171a21',
    border: '1px solid #262b36', borderRadius: 12, overflow: 'hidden', fontSize: 14,
  } as React.CSSProperties,
  th: {
    textAlign: 'left', padding: '11px 14px', fontSize: 12, fontWeight: 600, color: '#8b93a7',
    borderBottom: '1px solid #262b36', textTransform: 'uppercase', letterSpacing: 0.4,
  } as React.CSSProperties,
  td: { padding: '11px 14px', borderBottom: '1px solid #20242e' } as React.CSSProperties,
  muted: { fontSize: 12, color: '#8b93a7', marginTop: 2 } as React.CSSProperties,
  link: { color: '#93c5fd', textDecoration: 'none', fontWeight: 600 } as React.CSSProperties,
  late: { color: '#f87171', fontWeight: 600 } as React.CSSProperties,
  badge: {
    ok: badge('#14301f', '#4ade80', '#1e5334'),
    warn: badge('#2e2a16', '#fbbf24', '#4b4321'),
    due: badge('#1c2436', '#93c5fd', '#2b3b5a'),
    off: badge('#23262e', '#8b93a7', '#31353f'),
  },
};
