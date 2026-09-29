'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import type { CheckinTokenResponse } from '@pt/contracts';

/** Mã sống 60 giây; làm mới sớm hơn vài giây để không bao giờ hiện mã đã chết. */
const LAM_MOI_TRUOC = 5;

/**
 * Màn hình huấn luyện viên mở buổi tập.
 *
 * Mã QR chứa một ĐƯỜNG DẪN tới `/me/checkin?b=…&t=…`, không phải chuỗi thô:
 * camera mặc định của điện thoại mở được thẳng, nên hội viên không phải cài gì
 * và web không cần thư viện quét mã.
 *
 * Mã tự làm mới trước khi hết hạn. Đó là điều làm nó khác một ảnh chụp màn
 * hình: chụp lại rồi gửi cho người khác thì trong vòng một phút là vô dụng.
 */
export default function CheckinQr({ params }: { params: Promise<{ bookingId: string }> }) {
  const { bookingId } = use(params);

  const [anhQr, setAnhQr] = useState('');
  const [conLai, setConLai] = useState(0);
  const [loi, setLoi] = useState('');
  const dangChay = useRef(false);

  const xinMa = useCallback(async () => {
    if (dangChay.current) return;
    dangChay.current = true;
    try {
      const res = await fetch(`/api/proxy/bookings/${bookingId}/checkin-token`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message ?? 'Không mở được buổi tập');

      const t = data as CheckinTokenResponse;
      const url = `${window.location.origin}/me/checkin?b=${t.bookingId}&t=${encodeURIComponent(t.token)}`;
      setAnhQr(
        await QRCode.toDataURL(url, {
          width: 320,
          margin: 2,
          // Vùng trắng quanh mã là BẮT BUỘC để máy quét tách được ô — đừng cắt.
          color: { dark: '#0f1115', light: '#ffffff' },
        }),
      );
      setConLai(t.expiresInSeconds);
      setLoi('');
    } catch (e) {
      setLoi(e instanceof Error ? e.message : 'Đã có lỗi xảy ra');
    } finally {
      dangChay.current = false;
    }
  }, [bookingId]);

  useEffect(() => {
    void xinMa();
  }, [xinMa]);

  useEffect(() => {
    const id = setInterval(() => {
      setConLai((n) => {
        if (n <= LAM_MOI_TRUOC) {
          void xinMa();
          return 0;
        }
        return n - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [xinMa]);

  return (
    <main style={S.giua}>
      <h1 style={S.h1}>Quét mã để điểm danh</h1>
      <p style={S.sub}>Hội viên mở camera điện thoại và quét mã bên dưới.</p>

      {loi ? (
        <p style={S.loi}>{loi}</p>
      ) : anhQr ? (
        <>
          <img src={anhQr} alt="Mã điểm danh" style={S.qr} />
          <p style={S.dem}>
            Mã tự làm mới sau <strong>{conLai}</strong> giây
          </p>
        </>
      ) : (
        <p style={S.sub}>Đang tạo mã…</p>
      )}

      <button style={S.nut} onClick={() => void xinMa()}>
        Tạo mã mới
      </button>
    </main>
  );
}

const S: Record<string, React.CSSProperties> = {
  giua: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    gap: 12, textAlign: 'center', paddingTop: 20,
  },
  h1: { margin: 0, fontSize: 22 },
  sub: { margin: 0, fontSize: 13, color: '#8b93a7' },
  qr: { width: 320, height: 320, borderRadius: 12, background: '#fff' },
  dem: { margin: 0, fontSize: 13, color: '#8b93a7' },
  loi: { margin: 0, fontSize: 14, color: '#f87171' },
  nut: {
    padding: '10px 18px', borderRadius: 8, border: '1px solid #2c3240',
    background: '#171a21', color: '#e8ebf2', fontSize: 14, cursor: 'pointer',
  },
};
