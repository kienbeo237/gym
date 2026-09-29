import type { MySummary } from '@pt/contracts';
import { apiFetch, requireSession } from '../../lib/session';

const vnd = (n: number) => n.toLocaleString('vi-VN');
const TZ = 'Asia/Ho_Chi_Minh';

const MAU_CANH_BAO: Record<MySummary['warnings'][number]['kind'], string> = {
  LOW_SESSIONS: '#fbbf24',
  EXPIRING: '#fbbf24',
  EXPIRED: '#f87171',
  USED_UP: '#f87171',
};

function khiNao(phut: number): string {
  if (phut < 0) return 'đã qua giờ hẹn';
  if (phut < 60) return `còn ${phut} phút nữa`;
  if (phut < 60 * 24) return `còn ${Math.round(phut / 60)} giờ nữa`;
  return `còn ${Math.round(phut / 60 / 24)} ngày nữa`;
}

export default async function MeHome() {
  const session = await requireSession();
  const s = await apiFetch<MySummary>('/me/summary', session);

  const dangDung = s.packages.filter((p) => p.status === 'ACTIVE');

  return (
    <>
      <header style={S.head}>
        <h1 style={S.h1}>Chào {s.fullName.split(' ').slice(-1)[0]}</h1>
        <p style={S.sub}>Mã hội viên {s.memberCode}</p>
      </header>

      <section style={S.bigCard}>
        <span style={S.bigLabel}>Tổng số buổi còn lại</span>
        <strong style={S.bigNum}>{s.totalSessionsRemaining}</strong>
        {s.totalOutstanding > 0 && (
          <span style={S.no}>Còn nợ {vnd(s.totalOutstanding)} ₫</span>
        )}
      </section>

      {/* Cảnh báo tính ở BACKEND với cùng ngưỡng mà chiến dịch nhắc gia hạn
          dùng. Tính lại ở giao diện thì hội viên thấy "sắp hết" trên màn hình
          mà không nhận tin nhắn, hoặc ngược lại. */}
      {s.warnings.length > 0 && (
        <section style={S.canhBao}>
          {s.warnings.map((w, i) => (
            <p key={i} style={{ ...S.canhBaoDong, color: MAU_CANH_BAO[w.kind] }}>
              {w.message}
            </p>
          ))}
        </section>
      )}

      {s.nextBooking && (
        <section style={S.card}>
          <span style={S.label}>Buổi tập kế tiếp</span>
          <strong style={S.gio}>
            {new Date(s.nextBooking.startsAt).toLocaleString('vi-VN', {
              timeZone: TZ, weekday: 'long', day: '2-digit', month: '2-digit',
              hour: '2-digit', minute: '2-digit',
            })}
          </strong>
          <span style={S.phu}>
            với {s.nextBooking.trainerName} · {khiNao(s.nextBooking.minutesUntil)}
          </span>
        </section>
      )}

      <h2 style={S.h2}>Gói tập của bạn</h2>
      {dangDung.length === 0 && <p style={S.trong}>Bạn chưa có gói tập nào đang hoạt động.</p>}

      {dangDung.map((p) => {
        const daDung = p.sessionsTotal - p.sessionsRemaining;
        const pct = Math.round((daDung / p.sessionsTotal) * 100);
        return (
          <article key={p.id} style={S.card}>
            <div style={S.hang}>
              <strong style={S.tenGoi}>{p.name}</strong>
              <span style={S.maGoi}>{p.code}</span>
            </div>

            <div style={S.thanh}>
              <div style={{ ...S.thanhTrong, width: `${pct}%` }} />
            </div>
            <div style={S.hang}>
              <span style={S.phu}>
                đã dùng {daDung}/{p.sessionsTotal} buổi
              </span>
              <strong style={p.sessionsRemaining <= 3 ? S.conItDo : S.conIt}>
                còn {p.sessionsRemaining}
              </strong>
            </div>

            <div style={S.chiTiet}>
              <span>
                Hết hạn {p.expiresOn}
                {p.daysLeft >= 0 ? ` · còn ${p.daysLeft} ngày` : ' · đã quá hạn'}
              </span>
              {p.trainerName && <span>Huấn luyện viên: {p.trainerName}</span>}
              {p.outstanding > 0 && (
                <span style={{ color: '#fbbf24' }}>Còn nợ {vnd(p.outstanding)} ₫</span>
              )}
            </div>
          </article>
        );
      })}
    </>
  );
}

const S: Record<string, React.CSSProperties> = {
  head: { marginBottom: 16 },
  h1: { margin: 0, fontSize: 22 },
  h2: { margin: '22px 0 10px', fontSize: 14, color: '#b6bdcd' },
  sub: { margin: '3px 0 0', fontSize: 13, color: '#8b93a7' },
  bigCard: {
    background: 'linear-gradient(135deg, #1d3a6b, #171a21)',
    border: '1px solid #2b3b5a', borderRadius: 14, padding: '20px 18px',
    display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 12,
  },
  bigLabel: { fontSize: 12, color: '#93c5fd' },
  bigNum: { fontSize: 42, lineHeight: 1.1 },
  no: { fontSize: 12, color: '#fbbf24', marginTop: 6 },
  canhBao: {
    background: '#1c1a12', border: '1px solid #3d3520', borderRadius: 12,
    padding: '12px 14px', marginBottom: 12,
  },
  canhBaoDong: { margin: '3px 0', fontSize: 13 },
  card: {
    background: '#171a21', border: '1px solid #262b36', borderRadius: 12,
    padding: 16, marginBottom: 12, display: 'flex', flexDirection: 'column', gap: 7,
  },
  label: { fontSize: 11, color: '#8b93a7', textTransform: 'uppercase', letterSpacing: 0.4 },
  gio: { fontSize: 16 },
  phu: { fontSize: 12, color: '#8b93a7' },
  hang: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10 },
  tenGoi: { fontSize: 15 },
  maGoi: { fontSize: 11, color: '#8b93a7' },
  thanh: { height: 7, borderRadius: 999, background: '#0f1115', overflow: 'hidden' },
  thanhTrong: { height: '100%', background: '#3b82f6' },
  conIt: { fontSize: 14, color: '#4ade80' },
  conItDo: { fontSize: 14, color: '#f87171' },
  chiTiet: {
    display: 'flex', flexDirection: 'column', gap: 3, fontSize: 12, color: '#8b93a7',
    borderTop: '1px solid #20242e', paddingTop: 8, marginTop: 2,
  },
  trong: { fontSize: 13, color: '#8b93a7' },
};
