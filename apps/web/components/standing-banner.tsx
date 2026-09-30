import Link from 'next/link';
import { CalendarClock, Lock, TriangleAlert } from 'lucide-react';
import type { TenantStanding } from '@pt/contracts';
import { ngayISO, vnd } from '../lib/format';
import type { Session } from '../lib/session';
import { Alert } from './ui';

/**
 * Đọc tình trạng gói KHÔNG làm hỏng layout: lỗi mạng hay API chưa có endpoint
 * thì chỉ mất dải nhắc, không mất cả màn quản lý.
 */
async function layTinhTrang(session: Session): Promise<TenantStanding | null> {
  const base = process.env.API_INTERNAL_URL ?? 'http://localhost:4000/api';
  try {
    const res = await fetch(`${base}/subscription/standing`, {
      headers: { authorization: `Bearer ${session.accessToken}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(3000),
    });
    return res.ok ? ((await res.json()) as TenantStanding) : null;
  } catch {
    return null;
  }
}

/**
 * Dải trạng thái gói trên đầu mọi màn quản lý.
 *
 * Bị khoá / quá hạn thì MỌI nhân viên đều thấy — lễ tân cần biết vì sao nút
 * "Lưu" không chạy. Nhắc hoá đơn sắp tới hạn thì chỉ chủ phòng và quản lý thấy:
 * họ là người trả tiền, và số tiền không phải việc của lễ tân.
 */
export async function StandingBanner({ session }: { session: Session }) {
  const s = await layTinhTrang(session);
  if (!s) return null;
  const traTien = session.roles.some((r) => r === 'OWNER' || r === 'ADMIN');
  const linkTra = traTien ? (
    <>
      {' '}
      <Link href="/settings/subscription" className="link">
        Xem cách thanh toán
      </Link>
    </>
  ) : (
    ' Liên hệ chủ phòng để thanh toán.'
  );

  let noiDung: React.ReactNode = null;
  if (s.tenantStatus === 'SUSPENDED') {
    noiDung = (
      <Alert tone="danger" icon={Lock}>
        <span>
          <strong>Phòng tập đang bị tạm khoá</strong>
          {s.statusNote ? ` (${s.statusNote})` : ''}: vẫn xem được dữ liệu, nhưng mọi thao tác thêm/sửa đều bị chặn.
          {s.openInvoice ? linkTra : ' Liên hệ bộ phận hỗ trợ để mở khoá.'}
        </span>
      </Alert>
    );
  } else if (s.tenantStatus === 'PAST_DUE') {
    noiDung = (
      <Alert tone="warning" icon={TriangleAlert}>
        <span>
          <strong>Gói {s.planName} đã hết hạn ngày {ngayISO(s.paidThrough)}.</strong>
          {s.suspendOn ? ` Thanh toán trước ngày ${ngayISO(s.suspendOn)} để phòng không bị tạm khoá.` : ''}
          {linkTra}
        </span>
      </Alert>
    );
  } else if (traTien && s.openInvoice) {
    noiDung = (
      <Alert tone="info" icon={CalendarClock}>
        <span>
          Hoá đơn gói {s.planName} kỳ tới: <strong>{vnd(s.openInvoice.amount)}đ</strong>, hạn{' '}
          {ngayISO(s.openInvoice.dueDate)}.{linkTra}
        </span>
      </Alert>
    );
  }

  return noiDung && <div className="mb-16">{noiDung}</div>;
}
