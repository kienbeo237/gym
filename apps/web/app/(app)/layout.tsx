import Link from 'next/link';
import { requireSession } from '../../lib/session';

/**
 * Khung chung cho các màn đã đăng nhập.
 *
 * Nhóm route `(app)` không xuất hiện trong URL — nó chỉ để những màn này dùng
 * chung một layout, còn `/login` thì không.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();

  const nav = [
    { href: '/members', label: 'Hội viên' },
    { href: '/trainers', label: 'Huấn luyện viên' },
    { href: '/packages', label: 'Gói tập' },
  ];

  return (
    <div style={S.shell}>
      <nav style={S.nav}>
        <div style={S.brand}>
          <span style={S.logo}>PT</span>
          <span style={S.tenant}>{session.tenantName}</span>
        </div>
        <div style={S.links}>
          {nav.map((n) => (
            <Link key={n.href} href={n.href} style={S.link}>
              {n.label}
            </Link>
          ))}
        </div>
      </nav>
      <div style={S.body}>{children}</div>
    </div>
  );
}

const S: Record<string, React.CSSProperties> = {
  shell: { minHeight: '100dvh', background: '#0f1115', color: '#e8ebf2' },
  nav: {
    display: 'flex', alignItems: 'center', gap: 28, padding: '0 28px', height: 56,
    borderBottom: '1px solid #262b36', background: '#12151c',
    position: 'sticky', top: 0, zIndex: 10, flexWrap: 'wrap',
  },
  brand: { display: 'flex', alignItems: 'center', gap: 10 },
  logo: {
    display: 'grid', placeItems: 'center', width: 28, height: 28, borderRadius: 7,
    background: '#3b82f6', color: '#fff', fontSize: 12, fontWeight: 800,
  },
  tenant: { fontSize: 14, fontWeight: 600 },
  links: { display: 'flex', gap: 4 },
  link: {
    color: '#b6bdcd', textDecoration: 'none', fontSize: 14,
    padding: '7px 12px', borderRadius: 7,
  },
  body: { padding: '28px' },
};
