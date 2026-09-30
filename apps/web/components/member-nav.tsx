'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { CalendarDays, ChartLine, History, House, Receipt } from 'lucide-react';

const TABS = [
  { href: '/me', label: 'Tổng quan', icon: House },
  { href: '/me/schedule', label: 'Lịch tập', icon: CalendarDays },
  { href: '/me/history', label: 'Lịch sử', icon: History },
  { href: '/me/invoices', label: 'Hoá đơn', icon: Receipt },
  { href: '/me/progress', label: 'Tiến độ', icon: ChartLine },
];

/** Thanh tab ở ĐÁY màn hình — trong tầm ngón cái khi cầm điện thoại một tay. */
export function MemberNav() {
  const pathname = usePathname();
  // '/me' chỉ sáng khi đúng trang chủ, không sáng theo mọi trang con.
  const dangO = (href: string) => (href === '/me' ? pathname === '/me' : pathname.startsWith(href));

  return (
    <nav className="m-tabbar" aria-label="Điều hướng hội viên">
      {TABS.map(({ href, label, icon: Icon }) => (
        <Link key={href} href={href} className="m-tab" aria-current={dangO(href) ? 'page' : undefined}>
          <Icon size={21} />
          {label}
        </Link>
      ))}
    </nav>
  );
}
