import { Injectable, NotFoundException } from '@nestjs/common';
import PDFDocument from 'pdfkit';
import type { InvoiceDetail } from '@pt/contracts';
import { BillingService } from './billing.service';
import { TenantDb } from '../common/tenant-db.service';
import { requireContext } from '../common/tenant-context';
import { chiLaHoiVien } from '../common/member-scope';

/**
 * Hoá đơn PDF — dựng MỖI LẦN tải, không lưu.
 *
 * Cột `invoice.pdf_file_id` có sẵn từ 0003 nhưng cố ý chưa dùng: hoá đơn còn
 * thay đổi (thu thêm đợt, hoàn tiền, huỷ), bản lưu sẵn sẽ cũ đi mà không ai
 * biết. Dựng lại từ sổ thì luôn khớp màn hình. Chỉ khi có hoá đơn điện tử
 * (bản đã ký, bất biến) thì mới cần lưu — lúc đó dùng cột này.
 *
 * Font Be Vietnam Pro nhúng từ gói npm: font chuẩn của PDF (Helvetica…) không
 * có dấu tiếng Việt.
 */
const FONT = {
  thuong: require.resolve('@expo-google-fonts/be-vietnam-pro/400Regular/BeVietnamPro_400Regular.ttf'),
  dam: require.resolve('@expo-google-fonts/be-vietnam-pro/600SemiBold/BeVietnamPro_600SemiBold.ttf'),
};

const TRANG_THAI: Record<string, string> = {
  DRAFT: 'Nháp',
  OPEN: 'Chưa thu',
  PARTIALLY_PAID: 'Thu một phần',
  PAID: 'Đã thu đủ',
  VOID: 'Đã huỷ',
  REFUNDED: 'Đã hoàn tiền',
};
const HINH_THUC: Record<string, string> = {
  CASH: 'Tiền mặt',
  BANK_TRANSFER: 'Chuyển khoản',
  CARD: 'Thẻ',
  EWALLET: 'Ví điện tử',
  OTHER: 'Khác',
};
const TRANG_THAI_DOT: Record<string, string> = {
  DUE: 'Chưa đến hạn',
  OVERDUE: 'Quá hạn',
  PAID: 'Đã thu',
  WAIVED: 'Miễn',
};

const tien = (v: number) => `${new Intl.NumberFormat('vi-VN').format(v)} đ`;
const ngay = (iso: string) =>
  new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(iso));
/** Cột `date` về dạng YYYY-MM-DD — đổi thẳng, không qua Date (tránh lệch múi giờ). */
const ngayDate = (d: string) => d.slice(0, 10).split('-').reverse().join('/');

type Cot = { tieuDe: string; rong: number; phai?: boolean };

@Injectable()
export class InvoicePdfService {
  constructor(
    private readonly billing: BillingService,
    private readonly tdb: TenantDb,
  ) {}

  async build(id: string): Promise<{ code: string; pdf: Buffer }> {
    const inv = await this.billing.detail(id);

    // Hội viên chỉ tải được hoá đơn của chính mình. 404 chứ không 403: không
    // xác nhận rằng id kia tồn tại.
    const ctx = requireContext();
    if (chiLaHoiVien(ctx) && ctx.memberId !== inv.memberId) {
      throw new NotFoundException('INVOICE_NOT_FOUND');
    }

    const phong = await this.tdb.run((tx) => tx.selectFrom('tenant').select('name').executeTakeFirstOrThrow());
    return { code: inv.code, pdf: await ve(inv, phong.name) };
  }
}

function ve(inv: InvoiceDetail, tenPhong: string): Promise<Buffer> {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 48,
    info: { Title: `Hoá đơn ${inv.code}`, Author: tenPhong },
  });
  doc.registerFont('thuong', FONT.thuong);
  doc.registerFont('dam', FONT.dam);

  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const xong = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const trai = doc.page.margins.left;
  const rong = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const XAM = '#6b7280';

  // ---- Đầu trang ----------------------------------------------------------
  doc.font('dam').fontSize(16).fillColor('#111827').text(tenPhong, trai, 48, { width: rong * 0.6 });
  doc
    .font('dam').fontSize(20)
    .text('HOÁ ĐƠN', trai, 48, { width: rong, align: 'right' })
    .font('thuong').fontSize(10).fillColor(XAM)
    .text(`Số: ${inv.code}`, { width: rong, align: 'right' })
    .text(`Ngày lập: ${ngay(inv.issuedAt)}`, { width: rong, align: 'right' })
    .text(`Trạng thái: ${TRANG_THAI[inv.status] ?? inv.status}`, { width: rong, align: 'right' });

  doc.moveDown(1.5);
  doc.font('thuong').fontSize(10).fillColor(XAM).text('Khách hàng', trai);
  doc.font('dam').fontSize(12).fillColor('#111827').text(`${inv.memberName}`);
  doc.font('thuong').fontSize(10).fillColor(XAM).text(`Mã hội viên: ${inv.memberCode}`);
  doc.moveDown(1);

  // ---- Bảng -----------------------------------------------------------------
  const bang = (cot: Cot[], dong: string[][]) => {
    const veDong = (o: string[], dam: boolean) => {
      if (doc.y > doc.page.height - doc.page.margins.bottom - 40) doc.addPage();
      const y = doc.y;
      let x = trai;
      let cao = 0;
      doc.font(dam ? 'dam' : 'thuong').fontSize(9.5).fillColor(dam ? XAM : '#111827');
      cot.forEach((c, i) => {
        const w = c.rong * rong;
        const h = doc.heightOfString(o[i] ?? '', { width: w - 8 });
        doc.text(o[i] ?? '', x + 4, y, { width: w - 8, align: c.phai ? 'right' : 'left' });
        cao = Math.max(cao, h);
        x += w;
      });
      const day = y + cao + 6;
      doc.moveTo(trai, day - 2).lineTo(trai + rong, day - 2).lineWidth(0.5).strokeColor('#e5e7eb').stroke();
      doc.x = trai;
      doc.y = day + 2;
    };
    veDong(cot.map((c) => c.tieuDe), true);
    dong.forEach((o) => veDong(o, false));
  };

  bang(
    [
      { tieuDe: 'Nội dung', rong: 0.5 },
      { tieuDe: 'SL', rong: 0.08, phai: true },
      { tieuDe: 'Đơn giá', rong: 0.21, phai: true },
      { tieuDe: 'Thành tiền', rong: 0.21, phai: true },
    ],
    inv.items.map((it) => [
      it.packageCode ? `${it.description}\nMã hợp đồng: ${it.packageCode}` : it.description,
      String(it.quantity),
      tien(it.unitPrice),
      tien(it.amount),
    ]),
  );

  // ---- Tổng -----------------------------------------------------------------
  doc.moveDown(0.5);
  const tong = (nhan: string, giaTri: string, dam = false) => {
    const y = doc.y;
    doc.font(dam ? 'dam' : 'thuong').fontSize(dam ? 11.5 : 10).fillColor('#111827');
    doc.text(nhan, trai + rong * 0.5, y, { width: rong * 0.25, align: 'right' });
    doc.text(giaTri, trai + rong * 0.75, y, { width: rong * 0.25 - 4, align: 'right' });
    doc.x = trai;
  };
  tong('Tổng cộng', tien(inv.totalAmount), true);
  tong('Đã thu', tien(inv.paidAmount));
  if (inv.status !== 'VOID') tong('Còn phải thu', tien(inv.outstanding), inv.outstanding > 0);

  // ---- Lịch trả góp -----------------------------------------------------------
  if (inv.schedule.length > 0) {
    doc.moveDown(1.5);
    doc.font('dam').fontSize(11).fillColor('#111827').text('Lịch trả góp', trai);
    doc.moveDown(0.4);
    bang(
      [
        { tieuDe: 'Đợt', rong: 0.1 },
        { tieuDe: 'Hạn', rong: 0.2 },
        { tieuDe: 'Số tiền', rong: 0.22, phai: true },
        { tieuDe: 'Đã thu', rong: 0.22, phai: true },
        { tieuDe: 'Trạng thái', rong: 0.26 },
      ],
      inv.schedule.map((s) => [
        String(s.seq),
        ngayDate(s.dueDate),
        tien(s.amount),
        tien(s.paidAmount),
        TRANG_THAI_DOT[s.status] ?? s.status,
      ]),
    );
  }

  // ---- Lịch sử thu / hoàn ------------------------------------------------------
  if (inv.payments.length > 0) {
    doc.moveDown(1.5);
    doc.font('dam').fontSize(11).fillColor('#111827').text('Lịch sử thanh toán', trai);
    doc.moveDown(0.4);
    bang(
      [
        { tieuDe: 'Ngày', rong: 0.16 },
        { tieuDe: 'Loại', rong: 0.14 },
        { tieuDe: 'Hình thức', rong: 0.2 },
        { tieuDe: 'Tham chiếu', rong: 0.26 },
        { tieuDe: 'Số tiền', rong: 0.24, phai: true },
      ],
      inv.payments.map((p) => [
        ngay(p.paidAt),
        p.kind === 'REFUND' ? 'Hoàn tiền' : 'Thu',
        HINH_THUC[p.method] ?? p.method,
        p.reference ?? '',
        tien(p.signedAmount),
      ]),
    );
  }

  if (inv.note) {
    doc.moveDown(1.2);
    doc.font('thuong').fontSize(9.5).fillColor(XAM).text(`Ghi chú: ${inv.note}`, trai, doc.y, { width: rong });
  }

  // Chân trang: nói rõ đây không phải hoá đơn GTGT — tránh khách đem đi kê khai.
  doc.moveDown(2);
  doc
    .font('thuong').fontSize(8.5).fillColor(XAM)
    .text(
      'Chứng từ nội bộ do phòng tập phát hành, không thay thế hoá đơn giá trị gia tăng (hoá đơn điện tử).',
      trai,
      doc.y,
      { width: rong, align: 'center' },
    );

  doc.end();
  return xong;
}
