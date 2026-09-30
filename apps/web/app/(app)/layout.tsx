import { redirect } from 'next/navigation';
import { AppShell } from '../../components/app-shell';
import { StandingBanner } from '../../components/standing-banner';
import { isPlatform, isStaff, requireSession } from '../../lib/session';

/**
 * Khung chung cho các màn quản lý đã đăng nhập.
 *
 * Nhóm route `(app)` không xuất hiện trong URL — nó chỉ để những màn này dùng
 * chung một layout, còn `/login` thì không.
 *
 * Hội viên lạc vào đây được đưa về app của họ. Đó là điều hướng cho đỡ lạc,
 * không phải chốt chặn: API vẫn tự từ chối nếu họ gọi thẳng.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  if (isPlatform(session)) redirect('/platform');
  if (!isStaff(session)) redirect('/me');

  return (
    <AppShell tenantName={session.tenantName} fullName={session.fullName} roles={session.roles}>
      <StandingBanner session={session} />
      {children}
    </AppShell>
  );
}
