'use client';

import { use, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import QRCode from 'qrcode';
import { ArrowLeft, CircleAlert, LoaderCircle, RefreshCw, Smartphone } from 'lucide-react';
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
  const [tongThoiGian, setTongThoiGian] = useState(60);
  const [loi, setLoi] = useState('');
  const [dangTai, setDangTai] = useState(false);
  // Buổi đã xong / đã huỷ: tạo lại mã cũng vô ích, nên ẩn nút và chỉ đường về lịch.
  const [daDong, setDaDong] = useState(false);
  const dangChay = useRef(false);

  const xinMa = useCallback(async () => {
    if (dangChay.current) return;
    dangChay.current = true;
    setDangTai(true);
    try {
      const res = await fetch(`/api/proxy/bookings/${bookingId}/checkin-token`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        if (data.code === 'BOOKING_NOT_CHECKINABLE') {
          setDaDong(true);
          throw new Error('Buổi tập này đã điểm danh, đã huỷ hoặc đã đánh vắng — không cần mã nữa.');
        }
        throw new Error(data.message ?? 'Không mở được buổi tập');
      }

      const t = data as CheckinTokenResponse;
      const url = `${window.location.origin}/me/checkin?b=${t.bookingId}&t=${encodeURIComponent(t.token)}`;
      setAnhQr(
        await QRCode.toDataURL(url, {
          width: 600,
          margin: 2,
          // Vùng trắng quanh mã là BẮT BUỘC để máy quét tách được ô — đừng cắt.
          color: { dark: '#0f1115', light: '#ffffff' },
        }),
      );
      setConLai(t.expiresInSeconds);
      setTongThoiGian(t.expiresInSeconds);
      setLoi('');
    } catch (e) {
      setLoi(e instanceof Error ? e.message : 'Đã có lỗi xảy ra');
    } finally {
      dangChay.current = false;
      setDangTai(false);
    }
  }, [bookingId]);

  useEffect(() => {
    void xinMa();
  }, [xinMa]);

  useEffect(() => {
    // Đang lỗi thì thôi đếm — không tự gọi lại API mỗi vài giây vô ích.
    if (loi) return;
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
  }, [xinMa, loi]);

  const pct = tongThoiGian > 0 ? Math.max(0, Math.min(100, (conLai / tongThoiGian) * 100)) : 0;

  return (
    <>
      <Link href="/schedule" className="back-link">
        <ArrowLeft size={15} /> Lịch tập
      </Link>

      <section className="card qr-card">
        <div>
          <h1 className="page-title">Quét mã để điểm danh</h1>
          <p className="page-sub row-start" style={{ justifyContent: 'center', gap: 6, marginTop: 6 }}>
            <Smartphone size={15} style={{ flexShrink: 0 }} /> Hội viên mở camera điện thoại và quét mã bên dưới.
          </p>
        </div>

        {loi ? (
          <div className="alert w-full" data-tone={daDong ? 'info' : 'danger'} role="alert" style={{ textAlign: 'left' }}>
            <CircleAlert size={17} />
            <div className="alert-body">{loi}</div>
          </div>
        ) : anhQr ? (
          <>
            <div className="qr-frame">
              <img src={anhQr} alt="Mã QR điểm danh" />
            </div>
            <div className="countdown">
              <div className="progress" data-tone={conLai <= 15 ? 'warning' : undefined}>
                <span style={{ width: `${pct}%`, transition: 'width 1s linear' }} />
              </div>
              <p className="muted small">
                Mã tự làm mới sau <strong className="num">{conLai}</strong> giây
              </p>
            </div>
          </>
        ) : (
          <div className="qr-placeholder">
            <LoaderCircle size={28} className="spin" />
          </div>
        )}

        {daDong ? (
          <Link href="/schedule" className="btn btn-secondary">
            <ArrowLeft size={16} /> Về lịch tập
          </Link>
        ) : (
          <button className="btn btn-secondary" onClick={() => void xinMa()} disabled={dangTai}>
            <RefreshCw size={16} className={dangTai ? 'spin' : undefined} />
            Tạo mã mới
          </button>
        )}
      </section>
    </>
  );
}
