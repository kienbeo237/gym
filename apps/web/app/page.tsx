import { redirect } from 'next/navigation';
import { getSession, isPlatform, isStaff } from '../lib/session';

/**
 * Điều hướng theo vai trò.
 *
 * Hội viên vào app của họ; nhân viên vào màn quản lý; quản trị nền tảng vào
 * /platform. Chỉ là ĐIỀU HƯỚNG —
 * phân quyền thật nằm ở API, nên một hội viên tự gõ /members vẫn không đọc
 * được gì ngoài phạm vi của mình.
 */
export default async function Home() {
  const s = await getSession();
  if (!s) redirect('/login');
  if (isPlatform(s)) redirect('/platform');
  redirect(isStaff(s) ? '/schedule' : '/me');
}
