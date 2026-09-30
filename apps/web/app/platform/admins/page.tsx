import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { KeyRound } from 'lucide-react';
import type { PlatformAdminRow } from '@pt/contracts';
import { Avatar, Badge, Card, PageHeader } from '../../../components/ui';
import { ngayGioVN } from '../../../lib/format';
import { apiFetch, duCap, requireSession } from '../../../lib/session';
import { AddAdmin, AdminRowActions } from './admin-actions';

export const metadata: Metadata = { title: 'Quản trị viên' };

const CAP: Record<string, { text: string; tone: 'danger' | 'primary' | 'neutral'; desc: string }> = {
  SUPER: { text: 'Toàn quyền', tone: 'danger', desc: 'Mọi thao tác, kể cả cấp/thu quyền quản trị' },
  OPS: { text: 'Vận hành', tone: 'primary', desc: 'Tạo phòng, đổi gói, đối soát, khoá/mở phòng' },
  SUPPORT: { text: 'Hỗ trợ', tone: 'neutral', desc: 'Chỉ xem — không thay đổi được gì' },
};

/** identityId của phiên hiện tại, đọc từ access token (không cần xác thực chữ ký — chỉ để hiện "Bạn"). */
function toiLa(token: string): string | null {
  try {
    return (JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { sub?: string }).sub ?? null;
  } catch {
    return null;
  }
}

/**
 * Ai được vào trang nền tảng. Chỉ cấp Toàn quyền mới thấy trang này; API cũng
 * tự chặn (không tự hạ/thu quyền mình, không bỏ người Toàn quyền cuối cùng).
 */
export default async function Admins() {
  const session = await requireSession();
  if (!duCap(session, 'SUPER')) notFound();
  const rows = await apiFetch<PlatformAdminRow[]>('/platform/admins', session);
  const toi = toiLa(session.accessToken);

  return (
    <>
      <PageHeader title="Quản trị viên" sub={`${rows.length} người có quyền vào trang nền tảng`} />

      <div className="row-start mb-16" style={{ gap: 16, flexWrap: 'wrap' }}>
        {Object.entries(CAP).map(([k, c]) => (
          <span key={k} className="small muted row-start" style={{ gap: 6 }}>
            <Badge tone={c.tone}>{c.text}</Badge> {c.desc}
          </span>
        ))}
      </div>

      <Card flush>
        <div className="table-wrap">
          <table className="table table-flush">
            <thead>
              <tr>
                <th>Người</th>
                <th>Cấp</th>
                <th>Đăng nhập gần nhất</th>
                <th>Cấp quyền từ</th>
                <th aria-label="Thao tác" />
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => {
                const laToi = a.identityId === toi;
                return (
                  <tr key={a.identityId}>
                    <td>
                      <div className="row-start" style={{ gap: 10 }}>
                        <Avatar name={a.fullName} size="sm" />
                        <div>
                          <div className="cell-main">
                            {a.fullName}
                            {laToi && <span className="faint"> (bạn)</span>}
                          </div>
                          <div className="cell-sub mono">{a.phone}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <Badge tone={CAP[a.level]?.tone}>{CAP[a.level]?.text ?? a.level}</Badge>
                    </td>
                    <td className="small">
                      {a.lastLoginAt ? ngayGioVN(a.lastLoginAt) : <span className="muted">Chưa đăng nhập</span>}
                      {a.mustChangePassword && (
                        <div className="cell-sub row-start text-warning" style={{ gap: 4 }}>
                          <KeyRound size={12} /> Chưa đổi mật khẩu tạm
                        </div>
                      )}
                    </td>
                    <td className="small nowrap">{ngayGioVN(a.createdAt)}</td>
                    <td className="num">{!laToi && <AdminRowActions id={a.identityId} name={a.fullName} level={a.level} />}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="mt-24">
        <Card title="Cấp quyền cho người mới" desc="Theo số điện thoại. Người đã là chủ phòng hay nhân viên vẫn giữ tài khoản phòng tập của họ.">
          <AddAdmin />
        </Card>
      </div>
    </>
  );
}
