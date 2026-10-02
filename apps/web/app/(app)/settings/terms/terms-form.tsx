'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { CircleCheck, FileText, LoaderCircle, Save } from 'lucide-react';
import type { CurrentTerms, TermsVersion } from '@pt/contracts';
import { Card } from '../../../../components/ui';
import { goiApi } from '../../../../lib/client-api';
import { useAction } from '../../../../lib/use-action';

/** Khớp TERMS_MAX_CHARS ở @pt/contracts — client component không import giá trị từ đó. */
const TOI_DA = 50_000;
const TOI_THIEU = 20;

/** Bản gợi ý để chủ phòng sửa lại — không ai muốn bắt đầu từ trang trắng. */
const MAU = `1. ĐĂNG KÝ VÀ SỬ DỤNG GÓI TẬP
- Gói tập chỉ dùng cho chính hội viên đăng ký, không chuyển nhượng nếu không được phòng tập đồng ý.
- Gói tập có thời hạn sử dụng ghi trên hợp đồng. Buổi chưa dùng khi hết hạn không được hoàn lại.

2. ĐẶT LỊCH, HUỶ BUỔI VÀ VẮNG MẶT
- Vui lòng đặt lịch trước qua ứng dụng hoặc với huấn luyện viên.
- Huỷ buổi sát giờ hoặc vắng mặt không báo trước có thể bị trừ buổi theo chính sách đặt lịch của phòng.
- Đến muộn quá 15 phút, buổi tập có thể bị rút ngắn hoặc tính là vắng mặt.

3. BẢO LƯU VÀ HOÀN TIỀN
- Bảo lưu gói tập khi có lý do chính đáng (ốm đau, công tác…), tối đa … ngày, báo trước cho phòng tập.
- Phòng tập không hoàn tiền gói tập đã thanh toán, trừ trường hợp phòng tập không thể cung cấp dịch vụ.

4. NỘI QUY PHÒNG TẬP
- Mặc trang phục thể thao, mang giày sạch, mang khăn cá nhân.
- Sắp xếp lại dụng cụ sau khi tập. Không dùng dụng cụ khi chưa được hướng dẫn.
- Phòng tập không chịu trách nhiệm với tài sản cá nhân để ngoài tủ khoá.

5. SỨC KHOẺ VÀ AN TOÀN
- Hội viên tự khai báo tình trạng sức khoẻ, chấn thương, bệnh lý với huấn luyện viên trước khi tập.
- Dừng tập và báo ngay cho huấn luyện viên khi thấy chóng mặt, khó thở, đau ngực.

6. THÔNG TIN CÁ NHÂN
- Phòng tập dùng số điện thoại, ảnh tiến độ và lịch sử tập chỉ để phục vụ việc tập luyện và chăm sóc hội viên, không chia sẻ cho bên thứ ba.`;

export function TermsForm({ current, readOnly }: { current: CurrentTerms['current']; readOnly: boolean }) {
  const router = useRouter();
  const goc = current?.content ?? '';
  const [v, setV] = useState(goc);
  const [xong, setXong] = useState<TermsVersion | null>(null);
  const { busy, loi, chay } = useAction();
  const doDai = v.trim().length;
  const doi = v.trim() !== goc.trim();

  async function luu(e: React.FormEvent) {
    e.preventDefault();
    if (current && !confirm(`Đăng phiên bản ${current.version + 1}? Hội viên sẽ thấy nội dung mới ngay; phiên bản ${current.version} vẫn được lưu lại.`)) return;
    const r = await chay(() => goiApi<TermsVersion>('terms', { method: 'PUT', body: { content: v } }));
    if (r) {
      setXong(r);
      router.refresh();
    }
  }

  return (
    <form onSubmit={luu}>
      <Card
        title={current ? `Phiên bản ${current.version}` : 'Chưa có điều khoản'}
        desc={current ? 'Sửa rồi lưu sẽ tạo phiên bản mới.' : 'Hội viên chưa thấy gì ở mục Điều khoản trong app.'}
        actions={
          !readOnly && !current && !v.trim() ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setV(MAU)}>
              <FileText size={14} /> Dùng bản mẫu
            </button>
          ) : undefined
        }
      >
        <div className="stack" style={{ gap: 12 }}>
          <label className="field">
            <span className="field-label">Nội dung</span>
            <textarea
              className="input"
              rows={18}
              value={v}
              readOnly={readOnly}
              maxLength={TOI_DA}
              placeholder="Mỗi mục một đoạn, xuống dòng giữa các ý. Chỉ văn bản thuần — không cần định dạng."
              onChange={(e) => {
                setXong(null);
                setV(e.target.value);
              }}
              style={{ fontFamily: 'inherit', lineHeight: 1.6, resize: 'vertical' }}
            />
            <span className={doDai > TOI_DA * 0.95 ? 'field-hint text-warning' : 'field-hint'}>
              {doDai.toLocaleString('vi-VN')} / {TOI_DA.toLocaleString('vi-VN')} ký tự. Văn bản thuần: xuống dòng được giữ nguyên khi
              hội viên đọc.
            </span>
          </label>

          {loi && (
            <p className="field-hint text-danger" role="alert" style={{ margin: 0 }}>
              {loi}
            </p>
          )}
          {xong && !doi && (
            <p className="small text-success row-start" style={{ gap: 6, margin: 0 }}>
              <CircleCheck size={15} /> Đã đăng phiên bản {xong.version}.
            </p>
          )}

          {!readOnly && (
            <div className="row-start" style={{ gap: 8 }}>
              <button className="btn btn-primary" type="submit" disabled={busy || !doi || doDai < TOI_THIEU}>
                {busy ? <LoaderCircle size={16} className="spin" /> : <Save size={16} />}
                {current ? 'Đăng phiên bản mới' : 'Đăng điều khoản'}
              </button>
              {doi && current && (
                <button type="button" className="btn btn-ghost" onClick={() => setV(goc)} disabled={busy}>
                  Bỏ thay đổi
                </button>
              )}
            </div>
          )}
        </div>
      </Card>
    </form>
  );
}
