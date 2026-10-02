import type { Metadata } from 'next';
import { History, Info } from 'lucide-react';
import type { CurrentTerms, TermsVersionSummary } from '@pt/contracts';
import { Alert, Card, PageHeader } from '../../../../components/ui';
import { apiFetch, requireSession } from '../../../../lib/session';
import { gioVN, ngayISO, ngayVN } from '../../../../lib/format';
import { TermsForm } from './terms-form';

export const metadata: Metadata = { title: 'Điều khoản & chính sách' };

/**
 * Điều khoản & chính sách của phòng — hội viên đọc ở /me/terms. Mỗi lần lưu là
 * một phiên bản mới; phiên bản cũ giữ nguyên để đối chiếu khi có tranh chấp.
 */
export default async function TermsSettingsPage() {
  const session = await requireSession();
  const [{ current }, versions] = await Promise.all([
    apiFetch<CurrentTerms>('/terms', session),
    apiFetch<TermsVersionSummary[]>('/terms/versions', session),
  ]);
  const laChu = session.roles.includes('OWNER');

  return (
    <>
      <PageHeader
        title="Điều khoản & chính sách"
        sub="Nội quy, chính sách huỷ buổi, hoàn tiền, bảo lưu… Hội viên đọc trong app của mình."
      />
      {!laChu && (
        <div className="mb-16">
          <Alert tone="info" icon={Info}>
            <span>Chỉ chủ phòng tập sửa được điều khoản — đây là cam kết của phòng tập với hội viên.</span>
          </Alert>
        </div>
      )}
      <div className="stack" style={{ gap: 20 }}>
        <TermsForm current={current} readOnly={!laChu} />
        {versions.length > 0 && (
          <Card title="Lịch sử phiên bản" desc="Phiên bản cũ không bị xoá — dùng để đối chiếu khi có tranh chấp.">
            <div className="stack" style={{ gap: 6 }}>
              {versions.map((v, i) => (
                <div key={v.version} className="row small" style={{ gap: 12 }}>
                  <span className="row-start" style={{ gap: 8 }}>
                    <History size={14} className="faint" />
                    <span className="strong">Phiên bản {v.version}</span>
                    {i === 0 && <span className="text-success">· đang hiệu lực</span>}
                  </span>
                  <span className="muted">
                    {ngayISO(ngayVN(v.publishedAt))} {gioVN(v.publishedAt)}
                    {v.publishedByName ? ` · ${v.publishedByName}` : ''} · {v.length.toLocaleString('vi-VN')} ký tự
                  </span>
                </div>
              ))}
            </div>
          </Card>
        )}
      </div>
    </>
  );
}
