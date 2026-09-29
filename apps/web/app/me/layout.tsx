import Link from 'next/link';
import { requireSession } from '../../lib/session';

/**
 * Khung riêng cho app HỘI VIÊN — không dùng chung layout quản lý.
 *
 * Cố ý khác hẳn về bố cục: hội viên mở trên điện thoại, điều hướng nằm ở ĐÁY
 * màn hình trong tầm ngón cái, và không có thanh ngang nhiều mục như màn quản lý.
 */
export default async function MeLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();

  const nav = [
    { href: '/me', label: 'Tổng quan' },
    { href: '/me/schedule', label: 'Lịch tập' },
    { href: '/me/history', label: 'Lịch sử' },
    { href: '/me/invoices', label: 'Hoá đơn' },
    { href: '/me/progress', label: 'Tiến độ' },
  ];

  return (
    <div style={S.shell}>
      <header style={S.top}>
        <span style={S.logo}>PT</span>
        <span style={S.tenant}>{session.tenantName}</span>
      </header>

      <main style={S.body}>{children}</main>

      <nav style={S.bottom}>
        {nav.map((n) => (
          <Link key={n.href} href={n.href} style={S.tab}>
            {n.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  shell: {
    minHeight: '100dvh', background: '#0f1115', color: '#e8ebf2',
    display: 'flex', flexDirection: 'column',
  },
  top: {
    display: 'flex', alignItems: 'center', gap: 10, padding: '0 16px', height: 52,
    borderBottom: '1px solid #262b36', background: '#12151c',
    position: 'sticky', top: 0, zIndex: 10,
  },
  logo: {
    display: 'grid', placeItems: 'center', width: 26, height: 26, borderRadius: 7,
    background: '#3b82f6', color: '#fff', fontSize: 11, fontWeight: 800,
  },
  tenant: { fontSize: 14, fontWeight: 600 },
  body: { flex: 1, padding: '18px 16px 84px', maxWidth: 560, width: '100%', margin: '0 auto' },
  bottom: {
    position: 'fixed', bottom: 0, left: 0, right: 0,
    display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)',
    borderTop: '1px solid #262b36', background: '#12151c',
    paddingBottom: 'env(safe-area-inset-bottom)',
  },
  tab: {
    padding: '13px 4px', textAlign: 'center', fontSize: 12,
    color: '#b6bdcd', textDecoration: 'none',
  },
};
