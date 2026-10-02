import type { Metadata } from 'next';
import Link from 'next/link';
import { ChevronLeft, FileText } from 'lucide-react';
import type { CurrentTerms } from '@pt/contracts';
import { EmptyState } from '../../../components/ui';
import { apiFetch, requireSession } from '../../../lib/session';
import { ngayISO, ngayVN } from '../../../lib/format';

export const metadata: Metadata = { title: 'Điều khoản & chính sách' };

/** Hội viên đọc điều khoản đang hiệu lực của phòng. Văn bản thuần, giữ xuống dòng. */
export default async function MyTermsPage() {
  const session = await requireSession();
  const { current } = await apiFetch<CurrentTerms>('/terms', session);

  return (
    <div className="stack">
      <div>
        <Link href="/me" className="btn btn-ghost btn-sm" style={{ marginLeft: -8 }}>
          <ChevronLeft size={16} /> Tổng quan
        </Link>
        <h1 className="m-title">Điều khoản & chính sách</h1>
        {current && (
          <p className="m-sub">
            Phiên bản {current.version} · cập nhật {ngayISO(ngayVN(current.publishedAt))}
          </p>
        )}
      </div>

      {current ? (
        <article className="card" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.65 }}>
          {current.content}
        </article>
      ) : (
        <div className="card">
          <EmptyState icon={FileText} title="Phòng tập chưa đăng điều khoản" text="Hỏi lễ tân nếu bạn cần biết chính sách huỷ buổi, bảo lưu hoặc hoàn tiền." />
        </div>
      )}
    </div>
  );
}
