import { redirect } from 'next/navigation';
import { AppShell } from '../../components/app-shell';
import { isPlatform, requireSession } from '../../lib/session';

/**
 * Khung QUẢN TRỊ NỀN TẢNG — thấy mọi phòng tập, nên tách hẳn khỏi (app).
 *
 * Phiên phòng tập lạc vào đây được đưa về trang gốc. Chốt chặn thật ở API:
 * mọi route /platform chỉ nhận token phiên nền tảng, và kiểm lại cấp đang có
 * trong CSDL ở mỗi thao tác.
 */
export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const session = await requireSession();
  if (!isPlatform(session)) redirect('/');

  return (
    <AppShell
      tenantName="Quản trị nền tảng"
      fullName={session.fullName}
      roles={[]}
      platformLevel={session.platformLevel!}
    >
      {children}
    </AppShell>
  );
}
