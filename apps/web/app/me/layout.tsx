import Link from 'next/link';
import { Dumbbell, LayoutDashboard } from 'lucide-react';
import { LogoutButton } from '../../components/logout-button';
import { MemberNav } from '../../components/member-nav';
import { redirect } from 'next/navigation';
import { isPlatform, isStaff, requireSession } from '../../lib/session';

/**
 * Khung riêng cho app HỘI VIÊN — không dùng chung layout quản lý.
 *
 * Cố ý khác hẳn về bố cục: hội viên mở trên điện thoại, điều hướng nằm ở ĐÁY
 * màn hình trong tầm ngón cái, và không có thanh ngang nhiều mục như màn quản lý.
 */
export default async function MeLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  if (isPlatform(session)) redirect('/platform');

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
        {/* Nhân viên cũng là hội viên ở chính phòng mình được — cho họ lối về
            màn quản lý thay vì bắt đăng xuất. */}
        {isStaff(session) && (
          <Link href="/schedule" className="btn btn-ghost btn-sm" title="Màn quản lý">
            <LayoutDashboard size={16} />
            <span className="hide-sm">Quản lý</span>
          </Link>
        )}
        <LogoutButton className="btn btn-ghost btn-icon" />
      </header>

      <main className="m-main">{children}</main>

      <MemberNav />
    </div>
  );
}
