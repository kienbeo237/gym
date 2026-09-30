import type { Metadata } from 'next';
import Link from 'next/link';
import { ChevronLeft, ChevronRight, HandCoins, TriangleAlert } from 'lucide-react';
import type { PayrollResponse } from '@pt/contracts';
import { Alert, Avatar, Badge, Card, EmptyState, PageHeader, type Tone } from '../../../components/ui';
import { ngayGioVN, vnd } from '../../../lib/format';
import { apiFetch, requireSession } from '../../../lib/session';
import { PayrollActions } from './payroll-actions';

export const metadata: Metadata = { title: 'Bảng lương' };

const TRANG_THAI: Record<PayrollResponse['status'], { text: string; tone: Tone }> = {
  DRAFT: { text: 'Tạm tính', tone: 'warning' },
  CLOSED: { text: 'Đã chốt', tone: 'primary' },
  PAID: { text: 'Đã chi', tone: 'success' },
};

/** "2025-03" -> "03/2025". */
const thangVN = (m: string) => `${m.slice(5, 7)}/${m.slice(0, 4)}`;

/** "2025-03" ± n tháng. */
function dichThang(m: string, n: number): string {
  const [y, mo] = m.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, mo - 1 + n, 1)).toISOString().slice(0, 7);
}

export default async function PayrollPage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const session = await requireSession();
  const { month: raw } = await searchParams;
  const thangNay = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).slice(0, 7);
  // Mặc định tháng TRƯỚC: bảng lương chốt đầu tháng cho tháng vừa hết.
  const month = raw && /^\d{4}-\d{2}$/.test(raw) ? raw : dichThang(thangNay, -1);

  const d = await apiFetch<PayrollResponse>(`/reports/payroll?month=${month}`, session);
  const tt = TRANG_THAI[d.status];
  const tong = (k: 'baseSalary' | 'commissionSale' | 'commissionTeach' | 'adjustment' | 'sessionsTaught') =>
    d.lines.reduce((s, x) => s + x[k], 0);

  return (
    <>
      <PageHeader
        title={
          <span className="row-start" style={{ gap: 12, flexWrap: 'wrap' }}>
            Bảng lương {thangVN(d.month)}
            <Badge tone={tt.tone} dot>
              {tt.text}
            </Badge>
          </span>
        }
        sub={
          d.status === 'PAID' && d.paidAt
            ? `Đã chi lúc ${ngayGioVN(d.paidAt)}`
            : d.status === 'CLOSED' && d.closedAt
              ? `Chốt lúc ${ngayGioVN(d.closedAt)} — số liệu đã cố định`
              : 'Số liệu tạm tính theo thời gian thực, còn thay đổi đến khi chốt'
        }
        actions={
          <div className="btn-group">
            <Link href={`/payroll?month=${dichThang(d.month, -1)}`} aria-label="Tháng trước">
              <ChevronLeft size={16} />
            </Link>
            <span style={{ color: 'var(--text)', cursor: 'default' }}>Tháng {thangVN(d.month)}</span>
            {d.month < thangNay ? (
              <Link href={`/payroll?month=${dichThang(d.month, 1)}`} aria-label="Tháng sau">
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

      <div className="stack" style={{ gap: 20 }}>
        {d.status === 'DRAFT' && d.carriedOver.amount !== 0 && (
          <Alert tone="warning" icon={TriangleAlert}>
            <span>
              Có {d.carriedOver.entryCount} khoản hoa hồng thuộc các tháng đã chốt ({vnd(d.carriedOver.amount)} ₫) chưa được
              trả — thường do thu tiền ghi lùi ngày. Chúng sẽ được cộng vào bảng lương này khi chốt.
            </span>
          </Alert>
        )}

        <Card flush title="Chi tiết" desc={`${d.lines.length} huấn luyện viên · tổng chi ${vnd(d.totalPayout)} ₫`}>
          {d.lines.length === 0 ? (
            <EmptyState icon={HandCoins} title="Chưa có huấn luyện viên nào" />
          ) : (
            <div className="table-wrap">
              <table className="table table-flush">
                <thead>
                  <tr>
                    <th>Huấn luyện viên</th>
                    <th className="num">Buổi dạy</th>
                    <th className="num">Lương cứng</th>
                    <th className="num">HH bán</th>
                    <th className="num">HH dạy</th>
                    <th className="num">Điều chỉnh</th>
                    <th className="num">Thực nhận</th>
                  </tr>
                </thead>
                <tbody>
                  {d.lines.map((l) => (
                    <tr key={l.trainerId}>
                      <td>
                        <div className="cell-person">
                          <Avatar name={l.trainerName} />
                          <div>
                            <div className="cell-main">{l.trainerName}</div>
                            <div className="cell-sub">{l.trainerCode}</div>
                          </div>
                        </div>
                      </td>
                      <td className="num">{l.sessionsTaught}</td>
                      <td className="num muted">{vnd(l.baseSalary)}</td>
                      <td className="num">{vnd(l.commissionSale)}</td>
                      <td className="num">{vnd(l.commissionTeach)}</td>
                      <td className={l.adjustment < 0 ? 'num text-danger' : 'num'}>
                        {l.adjustment === 0 ? '—' : `${l.adjustment > 0 ? '+' : ''}${vnd(l.adjustment)}`}
                        {l.adjustmentNote && <div className="cell-sub">{l.adjustmentNote}</div>}
                      </td>
                      <td className="num strong text-primary">{vnd(l.total)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td className="strong">Tổng</td>
                    <td className="num strong">{tong('sessionsTaught')}</td>
                    <td className="num strong">{vnd(tong('baseSalary'))}</td>
                    <td className="num strong">{vnd(tong('commissionSale'))}</td>
                    <td className="num strong">{vnd(tong('commissionTeach'))}</td>
                    <td className="num strong">{vnd(tong('adjustment'))}</td>
                    <td className="num strong text-primary">{vnd(d.totalPayout)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </Card>

        <PayrollActions key={`${d.month}-${d.status}`} d={d} thangNay={thangNay} />
      </div>
    </>
  );
}
