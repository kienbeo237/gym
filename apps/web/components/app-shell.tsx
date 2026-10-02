'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  ArrowUpDown,
  Banknote,
  Building2,
  CalendarCog,
  CalendarDays,
  ChartColumn,
  CreditCard,
  Dumbbell,
  FileClock,
  FileText,
  Gauge,
  HandCoins,
  Landmark,
  Megaphone,
  Menu,
  MessageSquareText,
  Package,
  Receipt,
  Settings,
  ShieldHalf,
  UserCog,
  Users,
  X,
} from 'lucide-react';
import { TEN_VAI_TRO, mauAvatar, vietTat } from '../lib/format';
import { LogoutButton } from './logout-button';
import { NotificationBell, useInbox } from './notification-bell';

type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  roles?: string[];
  /** Chỉ sáng khi đúng đường dẫn này — cho mục gốc như /platform. */
  exact?: boolean;
  /** Mục nền tảng chỉ hiện từ cấp này trở lên (khớp @Platform ở API). */
  cap?: 'OPS' | 'SUPER';
};

const THU_TU_CAP = ['SUPPORT', 'OPS', 'SUPER'];

/**
 * Ẩn mục theo vai trò chỉ để KHÔNG dẫn người dùng tới màn họ sẽ bị từ chối.
 * Phân quyền thật vẫn nằm ở API — danh sách vai trò ở đây phải khớp @Roles của
 * endpoint mà màn đó gọi, không hơn.
 */
const NHOM_PHONG: { title: string; items: NavItem[] }[] = [
  {
    title: 'Vận hành',
    items: [
      { href: '/schedule', label: 'Lịch tập', icon: CalendarDays },
      { href: '/members', label: 'Hội viên', icon: Users },
      { href: '/trainers', label: 'Huấn luyện viên', icon: Dumbbell, roles: ['OWNER', 'ADMIN', 'RECEPTION'] },
    ],
  },
  {
    title: 'Kinh doanh',
    items: [
      { href: '/packages', label: 'Gói tập', icon: Package, roles: ['OWNER', 'ADMIN', 'RECEPTION'] },
      { href: '/invoices', label: 'Hoá đơn', icon: Receipt, roles: ['OWNER', 'ADMIN', 'RECEPTION'] },
      { href: '/reports', label: 'Báo cáo', icon: ChartColumn, roles: ['OWNER', 'ADMIN'] },
      { href: '/payroll', label: 'Bảng lương', icon: HandCoins, roles: ['OWNER'] },
    ],
  },
  {
    title: 'Chăm sóc',
    items: [
      { href: '/notifications', label: 'Tin nhắn', icon: MessageSquareText, roles: ['OWNER', 'ADMIN', 'RECEPTION'] },
      { href: '/campaigns', label: 'Chiến dịch', icon: Megaphone, roles: ['OWNER', 'ADMIN'] },
    ],
  },
  {
    title: 'Cài đặt',
    items: [
      { href: '/settings/subscription', label: 'Gói dịch vụ', icon: CreditCard, roles: ['OWNER', 'ADMIN'] },
      { href: '/settings/booking-policy', label: 'Đặt lịch & vắng', icon: CalendarCog, roles: ['OWNER', 'ADMIN'] },
      { href: '/settings/terms', label: 'Điều khoản', icon: FileText, roles: ['OWNER', 'ADMIN'] },
      { href: '/settings/zalo', label: 'Zalo OA', icon: Settings, roles: ['OWNER', 'ADMIN'] },
    ],
  },
];

/**
 * Màn QUẢN TRỊ NỀN TẢNG. Khai ở đây (không truyền từ layout) vì icon là
 * component — không đi qua ranh giới Server -> Client được.
 */
const NHOM_NEN_TANG: { title: string; items: NavItem[] }[] = [
  {
    title: 'Nền tảng',
    items: [
      { href: '/platform', label: 'Tổng quan', icon: Gauge, exact: true },
      { href: '/platform/tenants', label: 'Phòng tập', icon: Building2 },
      { href: '/platform/invoices', label: 'Đối soát thu tiền', icon: Landmark },
      { href: '/platform/bank', label: 'Giao dịch ngân hàng', icon: Banknote },
      { href: '/platform/plan-requests', label: 'Yêu cầu đổi gói', icon: ArrowUpDown },
      { href: '/platform/audit', label: 'Nhật ký thao tác', icon: FileClock },
      { href: '/platform/admins', label: 'Quản trị viên', icon: UserCog, cap: 'SUPER' },
    ],
  },
];

const TEN_CAP: Record<string, string> = { SUPPORT: 'Hỗ trợ (chỉ xem)', OPS: 'Vận hành', SUPER: 'Toàn quyền' };

export function AppShell({
  tenantName,
  fullName,
  roles,
  platformLevel,
  children,
}: {
  tenantName: string;
  fullName: string;
  roles: string[];
  /** Có giá trị = khung quản trị nền tảng thay cho khung phòng tập. */
  platformLevel?: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  // Chuyển trang thì đóng ngăn kéo trên điện thoại.
  useEffect(() => setOpen(false), [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const nenTang = Boolean(platformLevel);
  // Chuông chỉ có ở khung phòng tập, cho nhân viên (khớp @Roles của /inbox).
  const coChuong = !nenTang && roles.some((r) => ['OWNER', 'ADMIN', 'RECEPTION', 'PT'].includes(r));
  const inbox = useInbox(coChuong);
  const nhom = (nenTang ? NHOM_NEN_TANG : NHOM_PHONG).map((g) => ({
    ...g,
    items: g.items.filter(
      (i) =>
        (!i.roles || i.roles.some((r) => roles.includes(r))) &&
        (!i.cap || THU_TU_CAP.indexOf(platformLevel ?? '') >= THU_TU_CAP.indexOf(i.cap)),
    ),
  })).filter((g) => g.items.length > 0);

  const dangO = (i: NavItem) => pathname === i.href || (!i.exact && pathname.startsWith(i.href + '/'));
  const hienTai = nhom.flatMap((g) => g.items).find(dangO);
  const vaiTro = nenTang
    ? TEN_CAP[platformLevel!] ?? platformLevel!
    : roles.map((r) => TEN_VAI_TRO[r] ?? r).join(' · ') || 'Nhân viên';

  return (
    <div className="app">
      <aside className="sidebar" data-open={open} aria-label="Điều hướng chính">
        <div className="sb-brand">
          <span className="brand-mark" data-variant={nenTang ? 'platform' : undefined}>
            {nenTang ? <ShieldHalf size={18} strokeWidth={2.4} /> : <Dumbbell size={18} strokeWidth={2.4} />}
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="sb-brand-name">PT Studio</div>
            <div className="sb-brand-sub" title={tenantName}>
              {tenantName || 'Phòng tập'}
            </div>
          </div>
          {coChuong && <NotificationBell inbox={inbox} className="sb-bell" />}
        </div>

        {nhom.map((g) => (
          <div key={g.title}>
            <div className="sb-section">{g.title}</div>
            <nav className="sb-nav">
              {g.items.map((i) => (
                <Link key={i.href} href={i.href} className="sb-link" aria-current={dangO(i) ? 'page' : undefined}>
                  <i.icon size={18} />
                  {i.label}
                </Link>
              ))}
            </nav>
          </div>
        ))}

        <div className="sb-foot">
          <div className="sb-user">
            <span className="avatar avatar-sm" style={{ background: mauAvatar(fullName || tenantName) }} aria-hidden>
              {vietTat(fullName || tenantName || 'P T')}
            </span>
            <div style={{ minWidth: 0 }}>
              <div className="sb-user-name">{fullName || 'Tài khoản'}</div>
              <div className="sb-user-role">{vaiTro}</div>
            </div>
            <LogoutButton className="sb-logout" />
          </div>
        </div>
      </aside>

      <div className="scrim" data-open={open} onClick={() => setOpen(false)} aria-hidden />

      <div className="main">
        <header className="topbar">
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            aria-label={open ? 'Đóng menu' : 'Mở menu'}
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            {open ? <X size={20} /> : <Menu size={20} />}
          </button>
          <span className="topbar-title">{hienTai?.label ?? tenantName}</span>
          {coChuong && <NotificationBell inbox={inbox} className="topbar-bell" />}
        </header>
        <main className="container">{children}</main>
      </div>
    </div>
  );
}
