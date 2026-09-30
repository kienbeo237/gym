'use client';

import { useEffect } from 'react';
import { RefreshCw, TriangleAlert } from 'lucide-react';

/**
 * Màn lỗi dùng chung cho error.tsx của từng khu vực.
 *
 * Không in `error.message` ra màn hình: ở production Next đã che nó, và thông
 * báo nội bộ (tên endpoint, mã lỗi API) không giúp gì người dùng. `digest` thì
 * có — đọc cho kỹ thuật để tra log máy chủ.
 */
export function ErrorView({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="card">
      <div className="empty" style={{ padding: '56px 20px' }}>
        <span className="empty-icon" style={{ color: 'var(--danger)', background: 'var(--danger-soft)', borderColor: 'var(--danger-line)' }}>
          <TriangleAlert size={22} />
        </span>
        <p className="empty-title">Không tải được dữ liệu</p>
        <p className="empty-text">
          Máy chủ đang bận hoặc kết nối bị gián đoạn. Thử lại sau giây lát; nếu vẫn lỗi, báo cho quản trị kèm mã
          bên dưới.
        </p>
        {error.digest && <code className="faint small">Mã lỗi: {error.digest}</code>}
        <button type="button" className="btn btn-primary mt-8" onClick={reset}>
          <RefreshCw size={16} /> Thử lại
        </button>
      </div>
    </div>
  );
}
