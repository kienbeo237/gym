import type { Tone } from '../components/ui';

/** Nhãn trạng thái hoá đơn dùng chung cho danh sách và trang chi tiết. */
export const TRANG_THAI_HOA_DON: Record<string, { text: string; tone: Tone }> = {
  DRAFT: { text: 'Nháp', tone: 'neutral' },
  OPEN: { text: 'Chưa thu', tone: 'info' },
  PARTIALLY_PAID: { text: 'Thu một phần', tone: 'warning' },
  PAID: { text: 'Đã thu đủ', tone: 'success' },
  VOID: { text: 'Đã huỷ', tone: 'neutral' },
  REFUNDED: { text: 'Đã hoàn tiền', tone: 'neutral' },
};

export const TRANG_THAI_TIN: Record<string, { text: string; tone: Tone }> = {
  PENDING: { text: 'Chờ gửi', tone: 'info' },
  SENDING: { text: 'Đang gửi', tone: 'primary' },
  SENT: { text: 'Đã gửi', tone: 'success' },
  FAILED: { text: 'Lỗi', tone: 'danger' },
  SKIPPED: { text: 'Bỏ qua', tone: 'neutral' },
};

export const TEN_KENH: Record<string, string> = {
  ZALO_ZNS: 'Zalo ZNS',
  ZALO_OA: 'Zalo OA',
  SMS: 'SMS',
  EMAIL: 'Email',
  INAPP: 'Trong ứng dụng',
};

export const TRANG_THAI_OA: Record<string, { text: string; tone: Tone }> = {
  DISCONNECTED: { text: 'Chưa kết nối', tone: 'neutral' },
  CONNECTED: { text: 'Đã kết nối', tone: 'success' },
  TOKEN_EXPIRED: { text: 'Hết phiên — cần kết nối lại', tone: 'danger' },
  ERROR: { text: 'Lỗi kết nối', tone: 'danger' },
};

export const TRANG_THAI_MAU: Record<string, { text: string; tone: Tone }> = {
  NOT_SET: { text: 'Chưa khai', tone: 'neutral' },
  PENDING: { text: 'Chờ Zalo duyệt', tone: 'info' },
  APPROVED: { text: 'Đã duyệt', tone: 'success' },
  REJECTED: { text: 'Bị từ chối', tone: 'danger' },
  DISABLED: { text: 'Tạm tắt', tone: 'neutral' },
};

/** Điều kiện kích hoạt chiến dịch và ý nghĩa của "ngưỡng" với từng loại. */
export const LOAI_CHIEN_DICH: Record<string, { text: string; nguong: string; donVi: string }> = {
  LOW_SESSION_BALANCE: { text: 'Gói sắp hết buổi', nguong: 'Còn lại từ', donVi: 'buổi trở xuống' },
  PACKAGE_EXPIRING: { text: 'Gói sắp hết hạn', nguong: 'Hết hạn trong', donVi: 'ngày tới' },
  INACTIVE_MEMBER: { text: 'Lâu không tới tập', nguong: 'Vắng từ', donVi: 'ngày trở lên' },
  BIRTHDAY: { text: 'Sinh nhật', nguong: 'Gửi trước', donVi: 'ngày (0 = đúng ngày)' },
  PAYMENT_DUE: { text: 'Nhắc đóng tiền', nguong: 'Đến hạn trong', donVi: 'ngày tới' },
};

/**
 * Lý do lỗi do worker ghi (dạng `MÃ: mô tả`) -> câu cho lễ tân đọc.
 * Mã lạ thì hiện nguyên văn: thà khó hiểu còn hơn giấu mất thông tin.
 */
const LY_DO_TIN: Record<string, string> = {
  EXPIRED: 'Tin quá hạn nên không gửi nữa',
  CHANNEL_NOT_CONFIGURED: 'Kênh gửi chưa được cấu hình',
  NO_PHONE: 'Hội viên chưa có số điện thoại',
  TEMPLATE_NOT_APPROVED: 'Mẫu tin chưa khai mã Zalo đã duyệt',
  OA_NOT_CONNECTED: 'Zalo OA chưa kết nối',
  OA_TOKEN_EXPIRED: 'Phiên Zalo OA đã hết — cần kết nối lại',
  ZALO_UNREACHABLE: 'Không gọi được Zalo, sẽ thử lại',
  REDIS_UNAVAILABLE: 'Hệ thống tạm bận, sẽ thử lại',
  REFRESH_IN_PROGRESS: 'Đang làm mới phiên Zalo, sẽ thử lại',
  SECRET_UNREADABLE: 'Không giải mã được nội dung tin',
  UNKNOWN_TEMPLATE: 'Mẫu tin không có trong danh mục',
  QUOTA_EXCEEDED: 'Đã hết hạn mức tin Zalo của gói trong tháng này',
  SMS_NOT_CONFIGURED: 'Chưa cấu hình nhà cung cấp SMS',
  SMS_TEMPLATE_UNSUPPORTED: 'Loại tin này không gửi qua SMS',
};

// ---- Gói SaaS (phòng tập trả tiền cho nền tảng) ------------------------------

export const TRANG_THAI_PHONG: Record<string, { text: string; tone: Tone }> = {
  TRIAL: { text: 'Dùng thử', tone: 'info' },
  ACTIVE: { text: 'Đang hoạt động', tone: 'success' },
  PAST_DUE: { text: 'Quá hạn thanh toán', tone: 'warning' },
  SUSPENDED: { text: 'Tạm khoá', tone: 'danger' },
  CLOSED: { text: 'Đã đóng', tone: 'neutral' },
};

export const TRANG_THAI_THUE_BAO: Record<string, { text: string; tone: Tone }> = {
  TRIALING: { text: 'Dùng thử', tone: 'info' },
  ACTIVE: { text: 'Đang trả phí', tone: 'success' },
  PAST_DUE: { text: 'Quá hạn', tone: 'warning' },
  CANCELLED: { text: 'Đã huỷ', tone: 'neutral' },
};

export const TRANG_THAI_HD_SAAS: Record<string, { text: string; tone: Tone }> = {
  PENDING: { text: 'Chờ thanh toán', tone: 'warning' },
  PAID: { text: 'Đã thanh toán', tone: 'success' },
  WAIVED: { text: 'Miễn phí', tone: 'info' },
  VOID: { text: 'Đã huỷ', tone: 'neutral' },
};

export const TRANG_THAI_YEU_CAU_GOI: Record<string, { text: string; tone: Tone }> = {
  PENDING: { text: 'Chờ duyệt', tone: 'warning' },
  APPROVED: { text: 'Đã duyệt', tone: 'success' },
  REJECTED: { text: 'Từ chối', tone: 'danger' },
  CANCELLED: { text: 'Đã huỷ', tone: 'neutral' },
};

/** Kết quả tự khớp một giao dịch ngân hàng với hoá đơn gói. */
export const KET_QUA_GD: Record<string, { text: string; tone: Tone; hint: string }> = {
  MATCHED: { text: 'Đã tự khớp', tone: 'success', hint: 'Đúng nội dung và số tiền — hoá đơn đã tất toán.' },
  AMOUNT_MISMATCH: { text: 'Lệch số tiền', tone: 'warning', hint: 'Đúng hoá đơn nhưng sai số tiền. Hỏi lại phòng tập, rồi xác nhận tay hoặc hoàn tiền.' },
  ALREADY_SETTLED: { text: 'Chuyển trùng', tone: 'danger', hint: 'Hoá đơn này đã được thanh toán trước đó — nhiều khả năng khách chuyển hai lần.' },
  NO_MATCH: { text: 'Không khớp', tone: 'neutral', hint: 'Nội dung không chứa mã hoá đơn nào đang mở.' },
  AMBIGUOUS: { text: 'Khớp nhiều hoá đơn', tone: 'warning', hint: 'Nội dung chứa mã của hơn một hoá đơn — cần người chọn.' },
  IGNORED: { text: 'Tiền ra', tone: 'neutral', hint: 'Giao dịch chi, không liên quan thu tiền.' },
};

/** Hành động trong nhật ký nền tảng. `system.*` là job vòng đời, không phải người. */
export const HANH_DONG_NEN_TANG: Record<string, string> = {
  'platform.overview': 'Xem tổng quan',
  'plan.list': 'Xem danh mục gói',
  'tenant.list': 'Xem danh sách phòng',
  'tenant.view': 'Xem chi tiết phòng',
  'tenant.create': 'Tạo phòng tập',
  'tenant.suspend': 'Khoá phòng',
  'tenant.reactivate': 'Mở khoá phòng',
  'tenant.close': 'Đóng phòng',
  'subscription.change_plan': 'Đổi gói',
  'subscription.extend_trial': 'Gia hạn dùng thử',
  'invoice.list': 'Xem hàng đối soát',
  'invoice.issue': 'Phát hành hoá đơn',
  'invoice.confirm': 'Xác nhận đã nhận tiền',
  'invoice.waive': 'Miễn phí hoá đơn',
  'invoice.void': 'Huỷ hoá đơn',
  'audit.list': 'Xem nhật ký',
  'plan_request.list': 'Xem yêu cầu đổi gói',
  'plan_request.approve': 'Duyệt đổi gói',
  'plan_request.reject': 'Từ chối đổi gói',
  'bank.list': 'Xem giao dịch ngân hàng',
  'bank.resolve': 'Xử lý giao dịch chưa khớp',
  'bank.unmatched': 'Nhận tiền chưa khớp',
  'invoice.auto_confirm': 'Tự khớp chuyển khoản',
  'admin.list': 'Xem quản trị viên',
  'admin.add': 'Cấp quyền quản trị',
  'admin.change_level': 'Đổi cấp quản trị',
  'admin.revoke': 'Thu quyền quản trị',
  'system.invoice.issue': 'Tự phát hành hoá đơn',
  'system.subscription.past_due': 'Tự chuyển quá hạn',
  'system.subscription.renew_free': 'Tự gia hạn gói 0đ',
  'system.tenant.suspend': 'Tự khoá do quá hạn',
};

/** Tám view đối soát (API: VIEW_DOI_SOAT) — mỗi view là một loại lệch giữa số cache và sổ gốc. */
export const VIEW_DOI_SOAT: Record<string, string> = {
  v_session_balance_drift: 'Số buổi còn lại lệch sổ cái buổi tập',
  v_invoice_paid_drift: 'Tiền đã thu trên hoá đơn lệch tổng các lần thu',
  v_sale_commission_drift: 'Lần thu tiền không có đúng một dòng hoa hồng bán',
  v_commission_needs_policy: 'Hoa hồng 0đ vì không tìm được chính sách',
  v_revenue_drift: 'Buổi đã trừ không có đúng một dòng doanh thu',
  v_teach_commission_drift: 'Buổi đã dạy không có đúng một dòng hoa hồng dạy',
  v_revenue_over_contract: 'Doanh thu ghi nhận vượt giá hợp đồng',
  v_payroll_drift: 'Bảng lương đã chốt lệch hoa hồng gắn vào nó',
};

/** Thao tác GHI thì nổi bật trong nhật ký; thao tác xem thì mờ đi. */
export const laThaoTacXem = (action: string) =>
  /\.(view|list|overview)$/.test(action);

export function lyDoTin(loi: string | null): string | null {
  if (!loi) return null;
  const ma = /^(?:Hết \d+ lần thử: )?([A-Z_]+)\b/.exec(loi)?.[1];
  const cau = (ma && LY_DO_TIN[ma]) ?? loi;
  // OTP gửi Zalo hỏng thì worker chuyển sang SMS — giữ ý đó, nó trả lời câu
  // "vậy hội viên có nhận được mã không".
  return cau !== loi && loi.endsWith('đã chuyển sang SMS') ? `${cau} — đã chuyển sang SMS` : cau;
}

export const HINH_THUC_TT: Record<string, string> = {
  CASH: 'Tiền mặt',
  BANK_TRANSFER: 'Chuyển khoản',
  CARD: 'Thẻ',
  EWALLET: 'Ví điện tử',
  OTHER: 'Khác',
};

export const LOAI_GOI: Record<string, { text: string; tone: Tone }> = {
  PT: { text: 'Tập cùng HLV', tone: 'primary' },
  GYM: { text: 'Thẻ tập tự do', tone: 'info' },
  COMBO: { text: 'Gói kết hợp', tone: 'success' },
  CLASS: { text: 'Lớp nhóm', tone: 'warning' },
};

export const TRANG_THAI_HOP_DONG: Record<string, { text: string; tone: Tone }> = {
  ACTIVE: { text: 'Đang dùng', tone: 'success' },
  FROZEN: { text: 'Bảo lưu', tone: 'info' },
  EXPIRED: { text: 'Hết hạn', tone: 'neutral' },
  USED_UP: { text: 'Đã dùng hết', tone: 'neutral' },
  REFUNDED: { text: 'Đã hoàn tiền', tone: 'neutral' },
  CANCELLED: { text: 'Đã huỷ', tone: 'neutral' },
};

export const TRANG_THAI_BUOI: Record<string, { text: string; tone: Tone }> = {
  BOOKED: { text: 'Đã đặt', tone: 'info' },
  CHECKED_IN: { text: 'Đã điểm danh', tone: 'success' },
  COMPLETED: { text: 'Đã tập xong', tone: 'success' },
  NO_SHOW: { text: 'Vắng mặt', tone: 'danger' },
  CANCELLED_BY_MEMBER: { text: 'Hội viên huỷ', tone: 'neutral' },
  CANCELLED_BY_PT: { text: 'HLV huỷ', tone: 'neutral' },
  CANCELLED_BY_STAFF: { text: 'Phòng tập huỷ', tone: 'neutral' },
};

/**
 * Cách điểm danh. `ho: true` = điểm danh HỘ, không qua mã QR — hiện nổi bật để
 * chủ phòng đối soát (người bấm cũng là người được hoa hồng dạy).
 */
export const CACH_DIEM_DANH: Record<string, { text: string; ho: boolean }> = {
  QR: { text: 'Hội viên quét mã QR', ho: false },
  MEMBER_CONFIRM: { text: 'Hội viên tự xác nhận', ho: false },
  PT_CONFIRM: { text: 'HLV điểm danh hộ', ho: true },
  ADMIN: { text: 'Phòng tập điểm danh hộ', ho: true },
};

export const TEN_GIOI_TINH: Record<string, string> = { MALE: 'Nam', FEMALE: 'Nữ', OTHER: 'Khác' };

/** 0 = Chủ nhật, như `weekday` của API (và `Date.getDay()`). */
export const TEN_THU = ['Chủ nhật', 'Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7'];
