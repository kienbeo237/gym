'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { CircleAlert, CircleCheck, LoaderCircle, QrCode, TriangleAlert } from 'lucide-react';
import type { CheckinResponse } from '@pt/contracts';
import { ngayISO } from '../../../lib/format';

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
/** Lỗi hội viên hay gặp, nói bằng việc cần làm tiếp thay vì mã lỗi. */
const LOI_DIEM_DANH: Record<string, string> = {
  CHECKIN_TOKEN_INVALID:
    'Mã này đã hết hạn — mỗi mã chỉ dùng được trong 60 giây. Hãy quét lại mã mới đang hiện trên màn hình huấn luyện viên.',
  CHECKIN_TOKEN_REQUIRED: 'Không đọc được mã điểm danh. Hãy quét lại mã trên màn hình huấn luyện viên.',
  NOT_YOUR_BOOKING:
    'Buổi tập này không phải của tài khoản đang đăng nhập. Kiểm tra lại bạn đã đăng nhập đúng số điện thoại chưa.',
  BOOKING_NOT_CHECKINABLE: 'Buổi tập này đã được điểm danh, đã huỷ hoặc đã đánh vắng.',
  CHECKIN_OUT_OF_WINDOW: 'Chưa tới giờ (hoặc đã quá giờ) của buổi tập này nên chưa điểm danh được.',
  NO_MEMBER_PROFILE:
    'Tài khoản đang đăng nhập chưa có hồ sơ hội viên ở phòng tập này. Hãy đăng nhập bằng số điện thoại của hội viên.',
  NO_SESSION_LEFT:'Gói tập đã hết buổi. Vui lòng gia hạn tại quầy.',
  PACKAGE_EXPIRED: 'Gói tập đã hết hạn. Vui lòng gia hạn tại quầy.',
};

export default function MeCheckinPage() {
  // useSearchParams cần ranh giới Suspense, không thì cả trang bị ép render
  // phía client lúc build.
  return (
    <Suspense>
      <MeCheckin />
    </Suspense>
  );
}

function MeCheckin() {
  const sp = useSearchParams();
  const bookingId = sp.get('b') ?? '';
  const token = sp.get('t') ?? '';

  const [busy, setBusy] = useState(false);
  const [ketQua, setKetQua] = useState<CheckinResponse | null>(null);
  const [loi, setLoi] = useState('');
  const [phaiQuetLai, setPhaiQuetLai] = useState(false);

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
      if (!res.ok) {
        // Ca thường gặp nhất: mã chỉ sống 60 giây, và đăng nhập (nhận OTP) lâu
        // hơn thế. Bấm lại cũng vô ích — phải quét mã mới trên màn hình HLV.
        // Lỗi nghiệp vụ mang `code`; lỗi quyền (403) của Nest để mã trong `message`.
        const ma = String(data.code ?? data.message ?? '');
        if (ma === 'CHECKIN_TOKEN_INVALID' || ma === 'CHECKIN_TOKEN_REQUIRED') setPhaiQuetLai(true);
        throw new Error(LOI_DIEM_DANH[ma] ?? data.message ?? 'Không điểm danh được');
      }
      setKetQua(data as CheckinResponse);
    } catch (e) {
      setLoi(e instanceof Error ? e.message : 'Đã có lỗi xảy ra');
    } finally {
      setBusy(false);
    }
  }

  if (ketQua) {
    return (
      <div className="center-screen">
        <span className="success-mark">
          <CircleCheck size={38} />
        </span>
        <div>
          <h1 className="m-title">Đã điểm danh</h1>
          <p className="m-sub">Chúc bạn buổi tập hiệu quả!</p>
        </div>

        <div className="card list-card w-full" style={{ textAlign: 'left' }}>
          <dl className="dl">
            <div>
              <dt>Số buổi còn lại</dt>
              <dd className={ketQua.lowBalanceWarning ? 'text-danger' : undefined} style={{ fontSize: 17, fontWeight: 700 }}>
                {ketQua.sessionsRemaining}/{ketQua.sessionsTotal}
              </dd>
            </div>
            <div>
              <dt>Gói hết hạn</dt>
              <dd>{ngayISO(ketQua.expiresOn)}</dd>
            </div>
          </dl>
        </div>

        {/* Nhắc gia hạn ngay tại quầy, lúc hội viên còn đứng đó — hiệu quả hơn
            hẳn một tin nhắn gửi ba ngày sau. */}
        {ketQua.lowBalanceWarning && (
          <div className="alert w-full" data-tone="warning" style={{ textAlign: 'left' }}>
            <TriangleAlert size={17} />
            <div className="alert-body">Gói của bạn sắp hết buổi. Liên hệ quầy lễ tân để gia hạn nhé.</div>
          </div>
        )}

        <Link href="/me" className="btn btn-primary btn-lg btn-block">
          Về trang chính
        </Link>
      </div>
    );
  }

  return (
    <div className="center-screen">
      <span className="icon-tile" style={{ width: 64, height: 64, borderRadius: 18 }}>
        <QrCode size={30} />
      </span>
      <h1 className="m-title">Điểm danh buổi tập</h1>

      {thieuThamSo ? (
        <>
          <p className="m-sub" style={{ maxWidth: 340 }}>
            Không đọc được mã điểm danh. Hãy quét lại mã QR trên màn hình của huấn luyện viên.
          </p>
          <Link href="/me" className="btn btn-secondary btn-lg btn-block">
            Về trang chính
          </Link>
        </>
      ) : (
        <>
          <p className="m-sub" style={{ maxWidth: 340 }}>
            Xác nhận để ghi nhận buổi tập này. Một buổi sẽ được trừ khỏi gói của bạn.
          </p>
          {loi && (
            <div className="alert w-full" data-tone="danger" role="alert" style={{ textAlign: 'left' }}>
              <CircleAlert size={17} />
              <div className="alert-body">{loi}</div>
            </div>
          )}
          {phaiQuetLai ? (
            <Link href="/me" className="btn btn-secondary btn-lg btn-block">
              Về trang chính
            </Link>
          ) : (
            <>
              <button className="btn btn-primary btn-lg btn-block" onClick={() => void diemDanh()} disabled={busy}>
                {busy && <LoaderCircle size={18} className="spin" />}
                {busy ? 'Đang xử lý…' : 'Xác nhận điểm danh'}
              </button>
              <Link href="/me" className="btn btn-ghost btn-block">
                Huỷ
              </Link>
            </>
          )}
        </>
      )}
    </div>
  );
}
