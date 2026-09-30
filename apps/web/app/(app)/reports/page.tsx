import type { Metadata } from 'next';
import Link from 'next/link';
import {
  Banknote,
  CalendarClock,
  ChevronLeft,
  ChevronRight,
  Clock,
  FileText,
  Hourglass,
  TrendingUp,
  TriangleAlert,
  Users,
} from 'lucide-react';
import type { DashboardResponse, TrainerReportRow } from '@pt/contracts';
import { Avatar, Card, EmptyState, PageHeader, StatCard, Trend } from '../../../components/ui';
import { ngayGioVN, vnd, vndGon } from '../../../lib/format';
import { apiFetch, requireSession } from '../../../lib/session';

export const metadata: Metadata = { title: 'Báo cáo' };

function chenhLech(nay: number, truoc: number): { text: string; huong: 'up' | 'down' | 'flat' } {
  if (truoc === 0) return { text: nay === 0 ? 'không đổi' : 'mới', huong: nay === 0 ? 'flat' : 'up' };
  const pct = Math.round(((nay - truoc) / Math.abs(truoc)) * 100);
  if (pct === 0) return { text: '0%', huong: 'flat' };
  return { text: `${pct > 0 ? '+' : ''}${pct}%`, huong: pct > 0 ? 'up' : 'down' };
}

/** "2025-03" -> "03/2025". */
const thangVN = (m: string) => `${m.slice(5, 7)}/${m.slice(0, 4)}`;

/** "2025-03" ± n tháng. */
function dichThang(m: string, n: number): string {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, mo - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const session = await requireSession();
  const { month: raw } = await searchParams;
  const month = raw && /^\d{4}-\d{2}$/.test(raw) ? raw : undefined;

  const [db, trainers] = await Promise.all([
    apiFetch<DashboardResponse>(`/reports/dashboard${month ? `?month=${month}` : ''}`, session),
    apiFetch<TrainerReportRow[]>(`/reports/trainers${month ? `?month=${month}` : ''}`, session),
  ]);

  const c = db.current;
  const p = db.previous;
  const thangNay = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).slice(0, 7);

  const the = [
    {
      nhan: 'Tiền thu ròng',
      icon: Banknote,
      giatri: c.netCash,
      truoc: p.netCash,
      phu: c.cashOut > 0 ? `đã trừ ${vnd(c.cashOut)} ₫ hoàn lại` : 'chưa có khoản hoàn nào',
    },
    {
      nhan: 'Doanh thu ghi nhận',
      icon: TrendingUp,
      giatri: c.revenueRecognized,
      truoc: p.revenueRecognized,
      phu: `${c.sessionsTaught} buổi đã dạy · ${c.sessionsDeducted} buổi đã trừ`,
    },
    {
      nhan: 'Giá trị hợp đồng bán',
      icon: FileText,
      giatri: c.grossSales,
      truoc: p.grossSales,
      phu: `${c.packagesSold} hợp đồng · ${c.newMembers} hội viên mới`,
    },
  ];

  const tongDuKien = trainers.reduce((s, t) => s + t.estimatedPay, 0);

  return (
    <>
      {/* Nói rõ mốc làm mới: số liệu tổng hợp có độ trễ, còn màn hoá đơn đọc
          bảng gốc nên luôn tức thời. Không nói ra thì người dùng đối chiếu hai
          màn, thấy lệch, và kết luận hệ thống sai. */}
      <PageHeader
        title="Báo cáo"
        sub={
          db.refreshedAt ? (
            <span className="row-start" style={{ gap: 6 }}>
              <Clock size={14} /> Số liệu tổng hợp lúc {ngayGioVN(db.refreshedAt)}
            </span>
          ) : (
            'Số liệu tổng hợp theo tháng'
          )
        }
        actions={
          <div className="btn-group">
            <Link href={`/reports?month=${dichThang(c.month, -1)}`} aria-label="Tháng trước">
              <ChevronLeft size={16} />
            </Link>
            <span style={{ color: 'var(--text)', cursor: 'default' }}>Tháng {thangVN(c.month)}</span>
            {c.month < thangNay ? (
              <Link href={`/reports?month=${dichThang(c.month, 1)}`} aria-label="Tháng sau">
                <ChevronRight size={16} />
              </Link>
            ) : (
              <span aria-hidden style={{ opacity: 0.35, cursor: 'not-allowed' }}>
                <ChevronRight size={16} />
              </span>
            )}
          </div>
        }
      />

      <div className="stats">
        {the.map((t) => {
          const d = chenhLech(t.giatri, t.truoc);
          return (
            <StatCard
              key={t.nhan}
              label={t.nhan}
              icon={t.icon}
              value={vndGon(t.giatri)}
              unit="₫"
              trend={<Trend dir={d.huong}>{d.text}</Trend>}
              meta={
                <>
                  so với tháng {thangVN(p.month)}
                  <br />
                  {t.phu}
                </>
              }
            />
          );
        })}
      </div>

      <div className="stats">
        <StatCard
          label="Công nợ phải thu"
          icon={TriangleAlert}
          tone={db.outstanding.amount > 0 ? 'warning' : undefined}
          value={vndGon(db.outstanding.amount)}
          unit="₫"
          meta={
            <>
              {db.outstanding.invoiceCount} hoá đơn
              {db.outstanding.overdueCount > 0 && (
                <span className="text-danger"> · {db.outstanding.overdueCount} có đợt quá hạn</span>
              )}
            </>
          }
        />
        <StatCard
          label="Doanh thu chưa ghi nhận"
          icon={Hourglass}
          tone="info"
          value={vndGon(db.deferredRevenue.amount)}
          unit="₫"
          // Đây là NGHĨA VỤ, không phải tài sản: tiền đã thu cho những buổi
          // chưa dạy. Nói ra để chủ phòng không tiêu vào nó.
          meta={`tiền đã thu cho ${db.deferredRevenue.sessionsOutstanding} buổi chưa tập — phải trả lại nếu khách huỷ hợp đồng`}
        />
        <StatCard
          label="Cần chăm sóc"
          icon={CalendarClock}
          tone={db.lowBalance + db.expiringSoon > 0 ? 'danger' : undefined}
          value={db.lowBalance + db.expiringSoon}
          unit="hợp đồng"
          meta={`${db.lowBalance} sắp hết buổi · ${db.expiringSoon} sắp hết hạn`}
        />
        <StatCard
          label="Hội viên đang hoạt động"
          icon={Users}
          tone="success"
          value={db.activeMembers}
          meta="trên toàn phòng tập"
        />
      </div>

      <Card
        flush
        title="Huấn luyện viên"
        desc={`Tháng ${thangVN(c.month)} · dự kiến chi ${vnd(tongDuKien)} ₫`}
      >
        {trainers.length === 0 ? (
          <EmptyState icon={Users} title="Chưa có huấn luyện viên nào" />
        ) : (
          <div className="table-wrap">
            <table className="table table-flush">
              <thead>
                <tr>
                  <th>Huấn luyện viên</th>
                  <th className="num">Buổi dạy</th>
                  <th className="num">Buổi trừ</th>
                  <th className="num">Doanh thu</th>
                  <th className="num">HH bán</th>
                  <th className="num">HH dạy</th>
                  <th className="num">Lương cứng</th>
                  <th className="num">Dự kiến nhận</th>
                </tr>
              </thead>
              <tbody>
                {trainers.map((t) => (
                  <tr key={t.trainerId}>
                    <td>
                      <div className="cell-person">
                        <Avatar name={t.trainerName} />
                        <div>
                          <div className="cell-main">{t.trainerName}</div>
                          <div className="cell-sub">
                            {t.trainerCode} · {t.activeMembers} hội viên
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="num">{t.sessionsTaught}</td>
                    {/* Buổi TRỪ lớn hơn buổi DẠY nghĩa là có vắng mặt / huỷ muộn:
                        hai con số này khác nhau và huấn luyện viên sẽ hỏi. */}
                    <td className={t.sessionsDeducted > t.sessionsTaught ? 'num strong text-warning' : 'num'}>
                      {t.sessionsDeducted}
                    </td>
                    <td className="num">{vnd(t.revenueRecognized)}</td>
                    <td className="num">{vnd(t.commissionSale)}</td>
                    <td className="num">{vnd(t.commissionTeach)}</td>
                    <td className="num muted">{vnd(t.baseSalary)}</td>
                    <td className="num strong text-primary">{vnd(t.estimatedPay)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}
