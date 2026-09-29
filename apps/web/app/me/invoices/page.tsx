import type { MyInvoice } from '@pt/contracts';
import { apiFetch, requireSession } from '../../../lib/session';

const vnd = (n: number) => n.toLocaleString('vi-VN');

const NHAN: Record<string, string> = {
  OPEN: 'Chưa thanh toán',
  PARTIALLY_PAID: 'Đã thanh toán một phần',
  PAID: 'Đã thanh toán đủ',
  VOID: 'Đã huỷ',
  REFUNDED: 'Đã hoàn tiền',
};

export default async function MeInvoices() {
  const session = await requireSession();
  const rows = await apiFetch<MyInvoice[]>('/me/invoices', session);
  const tongNo = rows.reduce((s, r) => s + Math.max(0, r.outstanding), 0);
  const homNay = new Date().toISOString().slice(0, 10);

  return (
    <>
      <h1 style={S.h1}>Hoá đơn</h1>
      <p style={S.sub}>
        {tongNo > 0 ? `Còn nợ tổng cộng ${vnd(tongNo)} ₫` : 'Bạn không còn khoản nào phải thanh toán.'}
      </p>

      {rows.length === 0 && <p style={S.trong}>Chưa có hoá đơn nào.</p>}

      {rows.map((r) => {
        const quaHan = r.nextDueDate != null && r.nextDueDate < homNay;
        return (
          <article key={r.id} style={S.card}>
            <div style={S.hang}>
              <strong style={S.ma}>{r.code}</strong>
              <span style={S.ngay}>
                {new Date(r.issuedAt).toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}
              </span>
            </div>

            <div style={S.hang}>
              <span style={S.phu}>Tổng tiền</span>
              <span>{vnd(r.totalAmount)} ₫</span>
            </div>
            <div style={S.hang}>
              <span style={S.phu}>Đã thanh toán</span>
              <span>{vnd(r.paidAmount)} ₫</span>
            </div>
            {r.outstanding > 0 && (
              <div style={S.hang}>
                <span style={S.phu}>Còn lại</span>
                <strong style={{ color: '#fbbf24' }}>{vnd(r.outstanding)} ₫</strong>
              </div>
            )}

            {/* Đợt trả góp tới hạn là thứ hội viên cần thấy rõ nhất — quá hạn
                thì tô đỏ, không để họ phải tự so ngày. */}
            {r.isInstallment && r.nextDueDate && (
              <div style={{ ...S.dot, ...(quaHan ? S.dotQuaHan : {}) }}>
                {quaHan ? 'Quá hạn' : 'Đợt tới'}: {vnd(r.nextDueAmount ?? 0)} ₫ · hạn {r.nextDueDate}
              </div>
            )}

            <span style={S.trangThai}>{NHAN[r.status] ?? r.status}</span>
          </article>
        );
      })}
    </>
  );
}

const S: Record<string, React.CSSProperties> = {
  h1: { margin: 0, fontSize: 22 },
  sub: { margin: '3px 0 16px', fontSize: 13, color: '#8b93a7' },
  trong: { fontSize: 13, color: '#8b93a7' },
  card: {
    background: '#171a21', border: '1px solid #262b36', borderRadius: 12,
    padding: 16, marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 6,
  },
  hang: { display: 'flex', justifyContent: 'space-between', gap: 10, fontSize: 14 },
  ma: { fontSize: 15 },
  ngay: { fontSize: 12, color: '#8b93a7' },
  phu: { color: '#8b93a7' },
  dot: {
    marginTop: 4, padding: '8px 10px', borderRadius: 8, fontSize: 12,
    background: '#1c2436', color: '#93c5fd',
  },
  dotQuaHan: { background: '#2a1618', color: '#f87171' },
  trangThai: { fontSize: 11, color: '#8b93a7', marginTop: 2 },
};
