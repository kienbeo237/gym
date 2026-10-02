import type { Metadata } from 'next';
import Link from 'next/link';
import { Dumbbell, UserRoundX } from 'lucide-react';
import { LogoutButton } from '../../components/logout-button';
import { isStaff, requireSession } from '../../lib/session';

export const metadata: Metadata = { title: 'Chưa có hồ sơ hội viên' };

/**
 * Đăng nhập được nhưng KHÔNG có hồ sơ hội viên ở phòng đang chọn: nhân viên mở
 * link QR điểm danh, hoặc người có tài khoản ở nhiều phòng chọn nhầm phòng.
 *
 * Middleware REWRITE mọi /me/* về đây (địa chỉ trên trình duyệt giữ nguyên),
 * nên "Đăng nhập tài khoản khác" quay lại đúng trang đang mở. Trước đây trang
 * /me gọi API, nhận 403 NO_MEMBER_PROFILE và hiện "Không tải được dữ liệu —
 * máy chủ đang bận": sai nguyên nhân, bấm "Thử lại" bao nhiêu cũng vậy.
 */
export default async function ChuaCoHoSoPage() {
  const session = await requireSession();
  const laNhanVien = isStaff(session);

  return (
    <div className="m-shell">
      <header className="m-top">
        <span className="brand-mark">
          <Dumbbell size={16} strokeWidth={2.4} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="m-top-title">{session.tenantName || 'PT Studio'}</div>
          {session.fullName && <div className="m-top-sub">{session.fullName}</div>}
        </div>
      </header>

      <main className="m-main">
        <div className="center-screen">
          <span className="icon-tile" style={{ width: 64, height: 64, borderRadius: 18 }}>
            <UserRoundX size={30} />
          </span>
          <div>
            <h1 className="m-title">Chưa có hồ sơ hội viên</h1>
            <p className="m-sub" style={{ maxWidth: 360 }}>
              Tài khoản đang đăng nhập không phải hội viên của <strong>{session.tenantName || 'phòng tập này'}</strong>
              {laNhanVien ? ' — đây là tài khoản nhân viên.' : '.'} Để điểm danh hoặc xem gói tập, hãy đăng nhập bằng số
              điện thoại của hội viên (hoặc chọn đúng phòng tập khi đăng nhập).
            </p>
          </div>
          <LogoutButton className="btn btn-primary btn-lg btn-block" withLabel label="Đăng nhập tài khoản khác" giuTrang />
          {laNhanVien && (
            <Link href="/schedule" className="btn btn-ghost btn-block">
              Về màn quản lý
            </Link>
          )}
        </div>
      </main>
    </div>
  );
}
