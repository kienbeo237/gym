import { redirect } from 'next/navigation';
import { getSession } from '../lib/session';

/**
 * Điều hướng theo vai trò.
 *
 * Hội viên vào app của họ; nhân viên vào màn quản lý. Chỉ là ĐIỀU HƯỚNG —
 * phân quyền thật nằm ở API, nên một hội viên tự gõ /members vẫn không đọc
 * được gì ngoài phạm vi của mình.
 */
export default async function Home() {
  const s = await getSession();
  if (!s) redirect('/login');

  const laNhanVien = s.roles.some((r) => ['OWNER', 'ADMIN', 'RECEPTION', 'PT'].includes(r));
  redirect(laNhanVien ? '/members' : '/me');
}
