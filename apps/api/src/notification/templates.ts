import type { TemplateCode, TemplateParam } from '@pt/contracts';

/**
 * Danh mục mẫu tin — MỘT nơi duy nhất khai tham số của từng mẫu.
 *
 * Chủ phòng đăng ký mẫu ZNS trên Zalo với ĐÚNG các tên tham số dưới đây (màn
 * Cài đặt Zalo hiển thị lại danh sách này). Worker dựng `template_data` từ
 * cùng danh sách. Hai nơi khai riêng thì sớm muộn lệch nhau, và Zalo từ chối
 * cả lô tin với một lỗi "thiếu tham số" không nói thiếu cái nào.
 *
 * Mọi giá trị là CHUỖI đã định dạng kiểu Việt Nam: Zalo hiển thị nguyên văn.
 */

export type NguCanh = {
  memberName: string;
  gymName: string;
  payload: Record<string, unknown>;
  /** Bí mật đã giải mã (mã OTP) — chỉ có ở mẫu cần. */
  secret?: string;
};

type Mau = {
  name: string;
  description: string;
  params: TemplateParam[];
  build: (c: NguCanh) => Record<string, string>;
};

const TZ = 'Asia/Ho_Chi_Minh';

/** 'YYYY-MM-DD' -> 'DD/MM/YYYY'. Cột date là CHUỖI, không qua Date. */
function ngay(v: unknown): string {
  const s = String(v ?? '');
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
}

function thoiDiem(v: unknown): string {
  const d = new Date(String(v ?? ''));
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('vi-VN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
}

function tien(v: unknown): string {
  return `${new Intl.NumberFormat('vi-VN').format(Number(v ?? 0))} đ`;
}

/** Zalo giới hạn độ dài từng tham số; tên dài bị cắt thay vì làm hỏng cả tin. */
function ten(s: string): string {
  return s.length > 30 ? `${s.slice(0, 29)}…` : s;
}

const P = {
  customer: { key: 'customer_name', label: 'Tên hội viên', example: 'Lê Minh Anh' },
  gym: { key: 'gym_name', label: 'Tên phòng tập', example: 'Alpha Fitness' },
  remaining: { key: 'remaining', label: 'Số buổi còn lại', example: '7' },
  pkg: { key: 'package_name', label: 'Tên gói', example: 'Gói PT 10 buổi' },
  expires: { key: 'expires_on', label: 'Ngày hết hạn', example: '28/12/2026' },
} satisfies Record<string, TemplateParam>;

export const MAU_TIN: Record<TemplateCode, Mau> = {
  OTP_LOGIN: {
    name: 'Mã đăng nhập (OTP)',
    description: 'Gửi khi hội viên đăng nhập bằng số điện thoại. Đăng ký với Zalo dưới loại mẫu "OTP".',
    params: [{ key: 'otp', label: 'Mã OTP', example: '482913' }],
    build: (c) => ({ otp: c.secret ?? '' }),
  },
  CHECKIN_REMAINING: {
    name: 'Điểm danh thành công',
    description: 'Gửi ngay sau mỗi buổi điểm danh — hội viên biết buổi đã bị trừ và còn bao nhiêu.',
    params: [P.customer, P.gym, { key: 'session_time', label: 'Giờ tập', example: '18:30 29/09/2026' }, P.remaining, P.expires],
    build: (c) => ({
      customer_name: ten(c.memberName),
      gym_name: ten(c.gymName),
      session_time: thoiDiem(c.payload.occurredAt),
      remaining: String(c.payload.remaining ?? ''),
      expires_on: ngay(c.payload.expiresOn),
    }),
  },
  SESSION_DEDUCTED: {
    name: 'Trừ buổi do vắng / huỷ muộn',
    description: 'Gửi khi buổi bị trừ mà hội viên không tập. Nói rõ lý do để tránh tranh chấp.',
    params: [
      P.customer,
      P.gym,
      { key: 'reason', label: 'Lý do', example: 'Vắng mặt' },
      { key: 'session_time', label: 'Giờ hẹn', example: '18:30 29/09/2026' },
      P.remaining,
    ],
    build: (c) => ({
      customer_name: ten(c.memberName),
      gym_name: ten(c.gymName),
      reason: c.payload.reason === 'LATE_CANCEL' ? 'Huỷ muộn' : 'Vắng mặt',
      session_time: thoiDiem(c.payload.occurredAt),
      remaining: String(c.payload.remaining ?? ''),
    }),
  },
  PACKAGE_LOW_BALANCE: {
    name: 'Gói sắp hết buổi',
    description: 'Chiến dịch: nhắc gia hạn khi số buổi còn lại chạm ngưỡng.',
    params: [P.customer, P.gym, P.pkg, P.remaining, P.expires],
    build: (c) => ({
      customer_name: ten(c.memberName),
      gym_name: ten(c.gymName),
      package_name: ten(String(c.payload.packageName ?? '')),
      remaining: String(c.payload.remaining ?? ''),
      expires_on: ngay(c.payload.expiresOn),
    }),
  },
  PACKAGE_EXPIRING: {
    name: 'Gói sắp hết hạn',
    description: 'Chiến dịch: nhắc trước ngày hết hạn khi gói vẫn còn buổi chưa tập.',
    params: [P.customer, P.gym, P.pkg, P.expires, { key: 'days_left', label: 'Số ngày còn lại', example: '5' }, P.remaining],
    build: (c) => ({
      customer_name: ten(c.memberName),
      gym_name: ten(c.gymName),
      package_name: ten(String(c.payload.packageName ?? '')),
      expires_on: ngay(c.payload.expiresOn),
      days_left: String(c.payload.daysLeft ?? ''),
      remaining: String(c.payload.remaining ?? ''),
    }),
  },
  MEMBER_INACTIVE: {
    name: 'Lâu không tới tập',
    description: 'Chiến dịch: gọi hội viên quay lại khi đã lâu không điểm danh mà gói vẫn còn buổi.',
    params: [P.customer, P.gym, { key: 'days_inactive', label: 'Số ngày chưa tập', example: '14' }, P.remaining],
    build: (c) => ({
      customer_name: ten(c.memberName),
      gym_name: ten(c.gymName),
      days_inactive: String(c.payload.daysInactive ?? ''),
      remaining: String(c.payload.remaining ?? ''),
    }),
  },
  BIRTHDAY_GREETING: {
    name: 'Chúc mừng sinh nhật',
    description: 'Chiến dịch: gửi vào ngày sinh nhật (hoặc trước đó N ngày) của hội viên đang hoạt động.',
    params: [P.customer, P.gym],
    build: (c) => ({ customer_name: ten(c.memberName), gym_name: ten(c.gymName) }),
  },
  PAYMENT_DUE: {
    name: 'Nhắc đóng tiền trả góp',
    description: 'Chiến dịch: nhắc trước hạn của từng đợt trả góp chưa thanh toán.',
    params: [
      P.customer,
      P.gym,
      { key: 'invoice_code', label: 'Mã hoá đơn', example: 'HD0001' },
      { key: 'amount', label: 'Số tiền', example: '1.500.000 đ' },
      { key: 'due_date', label: 'Hạn đóng', example: '05/10/2026' },
    ],
    build: (c) => ({
      customer_name: ten(c.memberName),
      gym_name: ten(c.gymName),
      invoice_code: String(c.payload.invoiceCode ?? ''),
      amount: tien(c.payload.amount),
      due_date: ngay(c.payload.dueDate),
    }),
  },
};

export function laMaMau(code: string): code is TemplateCode {
  return Object.prototype.hasOwnProperty.call(MAU_TIN, code);
}
