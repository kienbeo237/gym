import Link from 'next/link';
import { Compass } from 'lucide-react';

export default function NotFound() {
  return (
    <main style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', padding: 16 }}>
      <div className="card" style={{ width: 'min(440px, 100%)' }}>
        <div className="empty" style={{ padding: '56px 24px' }}>
          <span className="empty-icon">
            <Compass size={22} />
          </span>
          <p className="page-title" style={{ fontSize: 40 }}>
            404
          </p>
          <p className="empty-title">Không tìm thấy trang</p>
          <p className="empty-text">Đường dẫn không tồn tại hoặc bạn không có quyền xem nội dung này.</p>
          <Link href="/" className="btn btn-primary mt-8">
            Về trang chính
          </Link>
        </div>
      </div>
    </main>
  );
}
