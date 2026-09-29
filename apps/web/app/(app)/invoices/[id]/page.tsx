import Link from 'next/link';
import type { InvoiceDetail } from '@pt/contracts';
import { apiFetch, requireSession } from '../../../../lib/session';

const vnd = (n: number) => n.toLocaleString('vi-VN');

const TEN_HINH_THUC: Record<string, string> = {
  CASH: 'Tiền mặt',
  BANK_TRANSFER: 'Chuyển khoản',
  CARD: 'Thẻ',
  EWALLET: 'Ví điện tử',
  OTHER: 'Khác',
};

const TEN_DOT: Record<string, string> = {
  DUE: 'Chưa đến hạn',
  OVERDUE: 'Quá hạn',
  PAID: 'Đã thu',
  WAIVED: 'Được miễn',
};

export default async function InvoiceDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const { id } = await params;
  const inv = await apiFetch<InvoiceDetail>(`/invoices/${id}`, session);

  const homNay = new Date().toISOString().slice(0, 10);

  return (
    <main>
      <Link href="/invoices" style={S.back}>
        ← Danh sách hoá đơn
      </Link>

      <header style={S.header}>
        <div>
          <h1 style={S.h1}>{inv.code}</h1>
          <p style={S.sub}>
            {inv.memberName} ({inv.memberCode}) ·{' '}
            {new Date(inv.issuedAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}
          </p>
        </div>
        <div style={S.tiles}>
          <div style={S.tile}>
            <span style={S.tileLabel}>Phải thu</span>
            <strong style={S.tileValue}>{vnd(inv.totalAmount)} ₫</strong>
          </div>
          <div style={S.tile}>
            <span style={S.tileLabel}>Đã thu</span>
            <strong style={S.tileValue}>{vnd(inv.paidAmount)} ₫</strong>
          </div>
          <div style={{ ...S.tile, ...(inv.outstanding > 0 ? { borderColor: '#5a2d33' } : {}) }}>
            <span style={S.tileLabel}>Còn lại</span>
            <strong style={{ ...S.tileValue, ...(inv.outstanding > 0 ? { color: '#f87171' } : {}) }}>
              {vnd(inv.outstanding)} ₫
            </strong>
          </div>
        </div>
      </header>

      <section style={S.card}>
        <h2 style={S.h2}>Nội dung</h2>
        <table style={S.table}>
          <tbody>
            {inv.items.map((it) => (
              <tr key={it.id}>
                <td style={S.td}>
                  {it.description}
                  {it.packageCode && <div style={S.muted}>Hợp đồng {it.packageCode}</div>}
                </td>
                <td style={{ ...S.td, textAlign: 'right', width: 160 }}>{vnd(it.amount)} ₫</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {inv.isInstallment && (
        <section style={S.card}>
          <h2 style={S.h2}>Kế hoạch trả góp</h2>
          <table style={S.table}>
            <thead>
              <tr>
                <th style={S.th}>Đợt</th>
                <th style={S.th}>Hạn</th>
                <th style={{ ...S.th, textAlign: 'right' }}>Số tiền</th>
                <th style={{ ...S.th, textAlign: 'right' }}>Đã thu</th>
                <th style={S.th}>Trạng thái</th>
              </tr>
            </thead>
            <tbody>
              {inv.schedule.map((s) => {
                // "Quá hạn" tính bằng cách so ngày, không chờ trạng thái trong
                // CSDL đổi: trạng thái chỉ được cập nhật khi có lần thu mới,
                // nên một đợt vừa qua hạn hôm nay vẫn còn là DUE.
                const quaHan = s.status !== 'PAID' && s.status !== 'WAIVED' && s.dueDate < homNay;
                return (
                  <tr key={s.id}>
                    <td style={S.td}>{s.seq}</td>
                    <td style={{ ...S.td, ...(quaHan ? S.late : {}) }}>{s.dueDate}</td>
                    <td style={{ ...S.td, textAlign: 'right' }}>{vnd(s.amount)} ₫</td>
                    <td style={{ ...S.td, textAlign: 'right' }}>{vnd(s.paidAmount)} ₫</td>
                    <td style={S.td}>
                      <span style={quaHan ? S.late : undefined}>
                        {quaHan ? 'Quá hạn' : (TEN_DOT[s.status] ?? s.status)}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      <section style={S.card}>
        <h2 style={S.h2}>Lịch sử thu / hoàn tiền</h2>
        {inv.payments.length === 0 ? (
          <p style={S.muted}>Chưa phát sinh giao dịch nào.</p>
        ) : (
          <table style={S.table}>
            <thead>
              <tr>
                <th style={S.th}>Thời điểm</th>
                <th style={S.th}>Loại</th>
                <th style={S.th}>Hình thức</th>
                <th style={{ ...S.th, textAlign: 'right' }}>Số tiền</th>
                <th style={S.th}>Người thực hiện</th>
                <th style={S.th}>Ghi chú</th>
              </tr>
            </thead>
            <tbody>
              {inv.payments.map((p) => (
                <tr key={p.id}>
                  <td style={S.td}>
                    {new Date(p.paidAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}
                  </td>
                  <td style={S.td}>
                    {p.kind === 'REFUND' ? (
                      <span style={S.late}>Hoàn tiền</span>
                    ) : (
                      'Thu tiền'
                    )}
                  </td>
                  <td style={S.td}>{TEN_HINH_THUC[p.method] ?? p.method}</td>
                  <td
                    style={{
                      ...S.td,
                      textAlign: 'right',
                      fontWeight: 600,
                      ...(p.signedAmount < 0 ? S.late : {}),
                    }}
                  >
                    {vnd(p.signedAmount)} ₫
                  </td>
                  <td style={S.td}>{p.receivedByName ?? '—'}</td>
                  <td style={{ ...S.td, ...S.muted }}>{p.note ?? p.reference ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {/* Hoàn tiền là dòng RIÊNG mang dấu âm, không sửa dòng thu cũ — nói ra
            để người đọc bảng hiểu vì sao tổng các dòng mới là số đã thu. */}
        {inv.payments.some((p) => p.kind === 'REFUND') && (
          <p style={S.note}>
            Khoản hoàn tiền được ghi thành dòng riêng mang dấu âm; dòng thu ban đầu giữ nguyên để
            lịch sử truy được.
          </p>
        )}
      </section>
    </main>
  );
}

const S: Record<string, React.CSSProperties> = {
  back: { color: '#8b93a7', fontSize: 13, textDecoration: 'none' },
  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end',
    gap: 16, margin: '12px 0 20px', flexWrap: 'wrap',
  },
  h1: { margin: 0, fontSize: 24 },
  h2: { margin: '0 0 12px', fontSize: 15, color: '#b6bdcd' },
  sub: { margin: '4px 0 0', fontSize: 13, color: '#8b93a7' },
  tiles: { display: 'flex', gap: 12 },
  tile: {
    display: 'flex', flexDirection: 'column', gap: 2, padding: '10px 16px',
    background: '#171a21', border: '1px solid #262b36', borderRadius: 10, minWidth: 130,
  },
  tileLabel: { fontSize: 11, color: '#8b93a7', textTransform: 'uppercase', letterSpacing: 0.4 },
  tileValue: { fontSize: 18 },
  card: {
    background: '#171a21', border: '1px solid #262b36', borderRadius: 12,
    padding: 18, marginBottom: 16,
  },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 14 },
  th: {
    textAlign: 'left', padding: '8px 10px', fontSize: 11, fontWeight: 600, color: '#8b93a7',
    borderBottom: '1px solid #262b36', textTransform: 'uppercase', letterSpacing: 0.4,
  },
  td: { padding: '9px 10px', borderBottom: '1px solid #20242e' },
  muted: { fontSize: 12, color: '#8b93a7' },
  late: { color: '#f87171' },
  note: { margin: '12px 0 0', fontSize: 12, color: '#6b7488' },
};
