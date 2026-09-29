import type { DashboardResponse, TrainerReportRow } from '@pt/contracts';
import { apiFetch, requireSession } from '../../../lib/session';

const vnd = (n: number) => n.toLocaleString('vi-VN');

function chenhLech(nay: number, truoc: number): { text: string; huong: 'len' | 'xuong' | 'phang' } {
  if (truoc === 0) return { text: nay === 0 ? '—' : 'mới', huong: nay === 0 ? 'phang' : 'len' };
  const pct = Math.round(((nay - truoc) / Math.abs(truoc)) * 100);
  if (pct === 0) return { text: '0%', huong: 'phang' };
  return { text: `${pct > 0 ? '+' : ''}${pct}%`, huong: pct > 0 ? 'len' : 'xuong' };
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const session = await requireSession();
  const { month } = await searchParams;

  const [db, trainers] = await Promise.all([
    apiFetch<DashboardResponse>(`/reports/dashboard${month ? `?month=${month}` : ''}`, session),
    apiFetch<TrainerReportRow[]>(`/reports/trainers${month ? `?month=${month}` : ''}`, session),
  ]);

  const c = db.current;
  const p = db.previous;

  const the = [
    {
      nhan: 'Tiền thu ròng',
      giatri: c.netCash,
      truoc: p.netCash,
      phu: c.cashOut > 0 ? `đã trừ ${vnd(c.cashOut)} ₫ hoàn lại` : 'chưa có khoản hoàn nào',
    },
    {
      nhan: 'Doanh thu ghi nhận',
      giatri: c.revenueRecognized,
      truoc: p.revenueRecognized,
      phu: `${c.sessionsTaught} buổi đã dạy · ${c.sessionsDeducted} buổi đã trừ`,
    },
    {
      nhan: 'Giá trị hợp đồng bán',
      giatri: c.grossSales,
      truoc: p.grossSales,
      phu: `${c.packagesSold} hợp đồng · ${c.newMembers} hội viên mới`,
    },
  ];

  return (
    <main>
      <header style={S.header}>
        <div>
          <h1 style={S.h1}>Báo cáo</h1>
          <p style={S.sub}>
            Tháng {c.month}
            {db.refreshedAt && (
              <>
                {' · '}số liệu tổng hợp lúc{' '}
                {new Date(db.refreshedAt).toLocaleString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' })}
              </>
            )}
          </p>
        </div>
      </header>

      {/* Nói rõ mốc làm mới: số liệu tổng hợp có độ trễ, còn màn hoá đơn đọc
          bảng gốc nên luôn tức thời. Không nói ra thì người dùng đối chiếu hai
          màn, thấy lệch, và kết luận hệ thống sai. */}

      <div style={S.theRow}>
        {the.map((t) => {
          const d = chenhLech(t.giatri, t.truoc);
          return (
            <div key={t.nhan} style={S.the}>
              <span style={S.theNhan}>{t.nhan}</span>
              <strong style={S.theSo}>{vnd(t.giatri)} ₫</strong>
              <span style={S.theChan}>
                <span style={S.mui[d.huong]}>{d.text}</span> so với {p.month}
              </span>
              <span style={S.thePhu}>{t.phu}</span>
            </div>
          );
        })}
      </div>

      <section style={S.canhBao}>
        <div style={S.canhBaoO}>
          <span style={S.theNhan}>Công nợ phải thu</span>
          <strong style={{ ...S.theSo, color: db.outstanding.amount > 0 ? '#fbbf24' : undefined }}>
            {vnd(db.outstanding.amount)} ₫
          </strong>
          <span style={S.thePhu}>
            {db.outstanding.invoiceCount} hoá đơn
            {db.outstanding.overdueCount > 0 && (
              <span style={S.doa}> · {db.outstanding.overdueCount} hoá đơn có đợt quá hạn</span>
            )}
          </span>
        </div>

        <div style={S.canhBaoO}>
          <span style={S.theNhan}>Doanh thu chưa ghi nhận</span>
          <strong style={S.theSo}>{vnd(db.deferredRevenue.amount)} ₫</strong>
          {/* Đây là NGHĨA VỤ, không phải tài sản: tiền đã thu cho những buổi
              chưa dạy. Nói ra để chủ phòng không tiêu vào nó. */}
          <span style={S.thePhu}>
            tiền đã thu cho {db.deferredRevenue.sessionsOutstanding} buổi chưa tập — phải trả lại
            nếu khách huỷ hợp đồng
          </span>
        </div>

        <div style={S.canhBaoO}>
          <span style={S.theNhan}>Cần chăm sóc</span>
          <strong style={S.theSo}>
            {db.lowBalance + db.expiringSoon}
          </strong>
          <span style={S.thePhu}>
            {db.lowBalance} hợp đồng sắp hết buổi · {db.expiringSoon} sắp hết hạn
          </span>
        </div>

        <div style={S.canhBaoO}>
          <span style={S.theNhan}>Hội viên đang hoạt động</span>
          <strong style={S.theSo}>{db.activeMembers}</strong>
          <span style={S.thePhu}>trên toàn phòng tập</span>
        </div>
      </section>

      <section style={S.bang}>
        <h2 style={S.h2}>Huấn luyện viên · tháng {c.month}</h2>
        <table style={S.table}>
          <thead>
            <tr>
              <th style={S.th}>Mã</th>
              <th style={S.th}>Họ tên</th>
              <th style={{ ...S.th, textAlign: 'right' }}>Buổi dạy</th>
              <th style={{ ...S.th, textAlign: 'right' }}>Buổi trừ</th>
              <th style={{ ...S.th, textAlign: 'right' }}>Doanh thu</th>
              <th style={{ ...S.th, textAlign: 'right' }}>HH bán</th>
              <th style={{ ...S.th, textAlign: 'right' }}>HH dạy</th>
              <th style={{ ...S.th, textAlign: 'right' }}>Lương cứng</th>
              <th style={{ ...S.th, textAlign: 'right' }}>Dự kiến nhận</th>
            </tr>
          </thead>
          <tbody>
            {trainers.map((t) => (
              <tr key={t.trainerId}>
                <td style={S.td}>{t.trainerCode}</td>
                <td style={{ ...S.td, fontWeight: 600 }}>
                  {t.trainerName}
                  <div style={S.muted}>{t.activeMembers} hội viên</div>
                </td>
                <td style={{ ...S.td, textAlign: 'right' }}>{t.sessionsTaught}</td>
                {/* Buổi TRỪ lớn hơn buổi DẠY nghĩa là có vắng mặt / huỷ muộn:
                    hai con số này khác nhau và huấn luyện viên sẽ hỏi. */}
                <td style={{ ...S.td, textAlign: 'right', color: t.sessionsDeducted > t.sessionsTaught ? '#fbbf24' : undefined }}>
                  {t.sessionsDeducted}
                </td>
                <td style={{ ...S.td, textAlign: 'right' }}>{vnd(t.revenueRecognized)}</td>
                <td style={{ ...S.td, textAlign: 'right' }}>{vnd(t.commissionSale)}</td>
                <td style={{ ...S.td, textAlign: 'right' }}>{vnd(t.commissionTeach)}</td>
                <td style={{ ...S.td, textAlign: 'right', color: '#8b93a7' }}>{vnd(t.baseSalary)}</td>
                <td style={{ ...S.td, textAlign: 'right', fontWeight: 700, color: '#93c5fd' }}>
                  {vnd(t.estimatedPay)}
                </td>
              </tr>
            ))}
            {trainers.length === 0 && (
              <tr>
                <td style={{ ...S.td, color: '#8b93a7' }} colSpan={9}>
                  Chưa có huấn luyện viên nào.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </main>
  );
}

const S = {
  header: { marginBottom: 18 } as React.CSSProperties,
  h1: { margin: 0, fontSize: 24 } as React.CSSProperties,
  h2: { margin: '0 0 12px', fontSize: 15, color: '#b6bdcd' } as React.CSSProperties,
  sub: { margin: '4px 0 0', fontSize: 13, color: '#8b93a7' } as React.CSSProperties,
  theRow: {
    display: 'grid', gap: 12, marginBottom: 12,
    gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
  } as React.CSSProperties,
  the: {
    background: '#171a21', border: '1px solid #262b36', borderRadius: 12, padding: 16,
    display: 'flex', flexDirection: 'column', gap: 3,
  } as React.CSSProperties,
  theNhan: {
    fontSize: 11, color: '#8b93a7', textTransform: 'uppercase', letterSpacing: 0.4,
  } as React.CSSProperties,
  theSo: { fontSize: 22 } as React.CSSProperties,
  theChan: { fontSize: 12, color: '#8b93a7' } as React.CSSProperties,
  thePhu: { fontSize: 11, color: '#6b7488', marginTop: 3 } as React.CSSProperties,
  doa: { color: '#f87171' } as React.CSSProperties,
  canhBao: {
    display: 'grid', gap: 12, marginBottom: 20,
    gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
  } as React.CSSProperties,
  canhBaoO: {
    background: '#12151c', border: '1px solid #262b36', borderRadius: 10, padding: 14,
    display: 'flex', flexDirection: 'column', gap: 2,
  } as React.CSSProperties,
  bang: {
    background: '#171a21', border: '1px solid #262b36', borderRadius: 12, padding: 18,
  } as React.CSSProperties,
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 14 } as React.CSSProperties,
  th: {
    textAlign: 'left', padding: '8px 10px', fontSize: 11, fontWeight: 600, color: '#8b93a7',
    borderBottom: '1px solid #262b36', textTransform: 'uppercase', letterSpacing: 0.4,
  } as React.CSSProperties,
  td: { padding: '10px', borderBottom: '1px solid #20242e' } as React.CSSProperties,
  muted: { fontSize: 11, color: '#8b93a7', fontWeight: 400, marginTop: 2 } as React.CSSProperties,
  mui: {
    len: { color: '#4ade80' } as React.CSSProperties,
    xuong: { color: '#f87171' } as React.CSSProperties,
    phang: { color: '#8b93a7' } as React.CSSProperties,
  },
};
