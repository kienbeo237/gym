import type { Metadata } from 'next';
import Link from 'next/link';
import { Dumbbell, HandCoins, TrendingUp, UserPlus, Users } from 'lucide-react';
import type { Paged, TrainerSummary } from '@pt/contracts';
import { Avatar, Badge, Card, EmptyState, PageHeader, StatCard, type Tone } from '../../../components/ui';
import { TZ, vnd, vndGon } from '../../../lib/format';
import { apiFetch, requireSession } from '../../../lib/session';

export const metadata: Metadata = { title: 'Huấn luyện viên' };

const TRANG_THAI: Record<string, { text: string; tone: Tone }> = {
  ACTIVE: { text: 'Đang làm', tone: 'success' },
  SUSPENDED: { text: 'Tạm nghỉ', tone: 'warning' },
  LEFT: { text: 'Đã nghỉ', tone: 'neutral' },
};

export default async function TrainersPage() {
  const session = await requireSession();
  const data = await apiFetch<Paged<TrainerSummary>>('/trainers?size=50', session);

  const thang = new Date().toLocaleDateString('vi-VN', { month: 'long', year: 'numeric', timeZone: TZ });

  const tongDoanhThu = data.items.reduce((s, t) => s + t.revenueThisMonth, 0);
  const tongHoaHong = data.items.reduce((s, t) => s + t.commissionThisMonth, 0);
  const tongBuoi = data.items.reduce((s, t) => s + t.sessionsThisMonth, 0);
  const dangLam = data.items.filter((t) => t.status === 'ACTIVE').length;
  // Hồ sơ đầy đủ (lương, hoa hồng) chỉ chủ phòng / quản lý xem — khớp @Roles của GET /trainers/:id.
  const laQuanLy = session.roles.some((r) => r === 'OWNER' || r === 'ADMIN');

  return (
    <>
      <PageHeader
        title="Huấn luyện viên"
        sub={`${data.total} người · số liệu ${thang}`}
        actions={
          laQuanLy ? (
            <Link href="/trainers/new" className="btn btn-primary">
              <UserPlus size={16} /> Thêm HLV
            </Link>
          ) : undefined
        }
      />

      <div className="stats">
        <StatCard
          label="Doanh thu ghi nhận"
          value={vndGon(tongDoanhThu)}
          unit="₫"
          icon={TrendingUp}
          // Nói rõ mốc ghi nhận ngay trên màn hình: đây là con số theo BUỔI ĐÃ
          // TẬP, không phải tiền đã thu. Hai số này khác nhau và người dùng sẽ hỏi.
          meta="theo buổi đã tập, không phải tiền đã thu"
        />
        <StatCard
          label="Hoa hồng phải trả"
          value={vndGon(tongHoaHong)}
          unit="₫"
          icon={HandCoins}
          tone="info"
          meta="gồm hoa hồng bán + dạy"
        />
        <StatCard label="Buổi đã dạy" value={tongBuoi} icon={Dumbbell} tone="success" meta={`trong ${thang}`} />
        <StatCard label="Đang làm việc" value={dangLam} unit={`/ ${data.items.length}`} icon={Users} />
      </div>

      <Card flush title="Danh sách huấn luyện viên" desc={`Hiệu suất ${thang}`}>
        {data.items.length === 0 ? (
          <EmptyState icon={Dumbbell} title="Chưa có huấn luyện viên nào" />
        ) : (
          <div className="table-wrap">
            <table className="table table-flush">
              <thead>
                <tr>
                  <th>Huấn luyện viên</th>
                  <th>Bậc</th>
                  <th className="num">Hội viên</th>
                  <th className="num">Buổi đã dạy</th>
                  <th className="num">Doanh thu (₫)</th>
                  <th className="num">Hoa hồng (₫)</th>
                  <th>Trạng thái</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((t) => {
                  const tt = TRANG_THAI[t.status] ?? { text: t.status, tone: 'neutral' as const };
                  return (
                    <tr key={t.id}>
                      <td>
                        <div className="cell-person">
                          <Avatar name={t.fullName} />
                          <div>
                            {laQuanLy ? (
                              <Link href={`/trainers/${t.id}`} className="cell-main link">
                                {t.fullName}
                              </Link>
                            ) : (
                              <div className="cell-main">{t.fullName}</div>
                            )}
                            <div className="cell-sub">
                              {t.code} · {t.phone}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td>{t.level ? <Badge tone="primary">{t.level}</Badge> : <span className="faint">—</span>}</td>
                      <td className="num">{t.activeMembers}</td>
                      <td className="num">{t.sessionsThisMonth}</td>
                      <td className="num">{vnd(t.revenueThisMonth)}</td>
                      <td className="num strong text-primary">{vnd(t.commissionThisMonth)}</td>
                      <td>
                        <Badge tone={tt.tone} dot>
                          {tt.text}
                        </Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
