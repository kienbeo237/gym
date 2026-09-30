'use client';

import { use, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { CircleAlert, LoaderCircle } from 'lucide-react';
import { goiApi, thongBaoLoi } from '../../../../../lib/client-api';

/**
 * Zalo chuyển trình duyệt về đây sau khi chủ OA cấp quyền:
 * `?code=…&state=…&oa_id=…`.
 *
 * Trang chỉ chuyển tiếp ba giá trị đó cho API. Đổi `code` lấy token — cần
 * secret và code_verifier — diễn ra ở máy chủ; trình duyệt không bao giờ thấy.
 */
export default function ZaloCallback({
  searchParams,
}: {
  searchParams: Promise<{ code?: string; state?: string; oa_id?: string; error?: string }>;
}) {
  const sp = use(searchParams);
  const router = useRouter();
  const [loi, setLoi] = useState('');
  // `state` chỉ dùng được MỘT lần (GETDEL). Strict mode chạy effect hai lần —
  // lần thứ hai sẽ bị từ chối và đè lỗi lên kết quả đúng.
  const daGui = useRef(false);

  useEffect(() => {
    if (daGui.current) return;
    daGui.current = true;
    if (!sp.code || !sp.state || !sp.oa_id) {
      setLoi(sp.error ? 'Bạn đã không cấp quyền cho ứng dụng trên Zalo.' : 'Thiếu thông tin Zalo trả về.');
      return;
    }
    goiApi('zalo/oa/callback', { method: 'POST', body: { code: sp.code, state: sp.state, oaId: sp.oa_id } })
      .then(() => router.replace('/settings/zalo?ketnoi=ok'))
      .catch((e) => setLoi(thongBaoLoi(e)));
  }, [sp, router]);

  return (
    <div className="card" style={{ maxWidth: 520, margin: '48px auto' }}>
      <div className="card-body stack" style={{ gap: 14, alignItems: 'center', textAlign: 'center' }}>
        {loi ? (
          <>
            <span className="icon-tile" data-tone="danger">
              <CircleAlert size={22} />
            </span>
            <div className="card-title">Chưa kết nối được Zalo OA</div>
            <p className="muted">{loi}</p>
            <Link href="/settings/zalo" className="btn btn-primary">
              Về trang cài đặt Zalo
            </Link>
          </>
        ) : (
          <>
            <LoaderCircle size={28} className="spin text-primary" />
            <div className="card-title">Đang hoàn tất kết nối…</div>
          </>
        )}
      </div>
    </div>
  );
}
