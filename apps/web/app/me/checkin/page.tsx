'use client';

import { useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import type { CheckinResponse } from '@pt/contracts';

/**
 * Trang đích khi hội viên quét mã QR trên màn hình huấn luyện viên.
 *
 * Mã QR chứa một ĐƯỜNG DẪN tới đúng trang này kèm `b` (buổi tập) và `t` (mã),
 * nên camera mặc định của điện thoại mở được thẳng — hội viên không phải cài
 * gì và web không cần thư viện quét mã.
 *
 * Điểm danh chạy khi người dùng BẤM, không chạy lúc mở trang: nó là thao tác
 * trừ một buổi tập, và thao tác đổi dữ liệu thì không nên xảy ra chỉ vì một
 * đường dẫn được mở (trình duyệt, ứng dụng chat, phần mềm quét virus đều có
 * thể mở trước nó).
 */
export default function MeCheckin() {
  const sp = useSearchParams();
  const bookingId = sp.get('b') ?? '';
  const token = sp.get('t') ?? '';

  const [busy, setBusy] = useState(false);
  const [ketQua, setKetQua] = useState<CheckinResponse | null>(null);
  const [loi, setLoi] = useState('');

  const thieuThamSo = !bookingId || !token;

  async function diemDanh() {
    setBusy(true);
    setLoi('');
    try {
      const res = await fetch('/api/proxy/me/checkin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bookingId, token }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message ?? 'Không điểm danh được');
      setKetQua(data as CheckinResponse);
    } catch (e) {
      setLoi(e instanceof Error ? e.message : 'Đã có lỗi xảy ra');
    } finally {
      setBusy(false);
    }
  }

  if (ketQua) {
    return (
      <div style={S.giua}>
        <div style={S.dau}>✓</div>
        <h1 style={S.h1}>Đã điểm danh</h1>
        <p style={S.sub}>Chúc bạn buổi tập hiệu quả.</p>

        <div style={S.card}>
          <div style={S.hang}>
            <span style={S.phu}>Số buổi còn lại</span>
            <strong style={ketQua.lowBalanceWarning ? S.doDam : S.dam}>
              {ketQua.sessionsRemaining}/{ketQua.sessionsTotal}
            </strong>
          </div>
          <div style={S.hang}>
            <span style={S.phu}>Gói hết hạn</span>
            <span>{ketQua.expiresOn}</span>
          </div>
        </div>

        {/* Nhắc gia hạn ngay tại quầy, lúc hội viên còn đứng đó — hiệu quả hơn
            hẳn một tin nhắn gửi ba ngày sau. */}
        {ketQua.lowBalanceWarning && (
          <p style={S.nhac}>
            Gói của bạn sắp hết buổi. Liên hệ quầy lễ tân để gia hạn nhé.
          </p>
        )}

        <Link href="/me" style={S.nut}>
          Về trang chính
        </Link>
      </div>
    );
  }

  return (
    <div style={S.giua}>
      <h1 style={S.h1}>Điểm danh buổi tập</h1>

      {thieuThamSo ? (
        <>
          <p style={S.sub}>
            Không đọc được mã điểm danh. Hãy quét lại mã QR trên màn hình của huấn luyện viên.
          </p>
          <Link href="/me" style={S.nutPhu}>
            Về trang chính
          </Link>
        </>
      ) : (
        <>
          <p style={S.sub}>
            Xác nhận để ghi nhận buổi tập này. Một buổi sẽ được trừ khỏi gói của bạn.
          </p>
          {loi && <p style={S.loi}>{loi}</p>}
          <button style={S.nut} onClick={() => void diemDanh()} disabled={busy}>
            {busy ? 'Đang xử lý…' : 'Xác nhận điểm danh'}
          </button>
          <Link href="/me" style={S.nutPhu}>
            Huỷ
          </Link>
        </>
      )}
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  giua: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    textAlign: 'center', gap: 12, paddingTop: 32,
  },
  dau: {
    width: 64, height: 64, borderRadius: '50%', display: 'grid', placeItems: 'center',
    background: '#14301f', color: '#4ade80', fontSize: 32, border: '2px solid #1e5334',
  },
  h1: { margin: 0, fontSize: 22 },
  sub: { margin: 0, fontSize: 14, color: '#8b93a7', maxWidth: 320 },
  card: {
    width: '100%', background: '#171a21', border: '1px solid #262b36', borderRadius: 12,
    padding: 16, display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8,
  },
  hang: { display: 'flex', justifyContent: 'space-between', fontSize: 14 },
  phu: { color: '#8b93a7' },
  dam: { fontSize: 16 },
  doDam: { fontSize: 16, color: '#f87171' },
  nhac: {
    margin: 0, fontSize: 13, color: '#fbbf24', background: '#1c1a12',
    border: '1px solid #3d3520', borderRadius: 10, padding: '10px 14px',
  },
  nut: {
    marginTop: 8, padding: '13px 20px', borderRadius: 10, border: 'none',
    background: '#3b82f6', color: '#fff', fontSize: 15, fontWeight: 600,
    cursor: 'pointer', textDecoration: 'none', minWidth: 220,
  },
  nutPhu: { fontSize: 13, color: '#8b93a7', textDecoration: 'none', marginTop: 4 },
  loi: { margin: 0, fontSize: 13, color: '#f87171' },
};
