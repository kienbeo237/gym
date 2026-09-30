import { Body, Controller, Headers, HttpCode, NotFoundException, Post, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { Public } from '../common/auth.guard';
import { ZodPipe } from '../common/zod.pipe';
import { PlatformService } from '../platform/platform.service';

/**
 * Payload webhook của SePay (https://docs.sepay.vn — "Tích hợp webhooks").
 * Chỉ khai các trường dùng tới; phần còn lại vẫn được lưu nguyên trong
 * `bank_txn_event.payload` để đối chiếu về sau.
 */
const SepayPayload = z
  .object({
    id: z.union([z.number().int(), z.string().min(1)]),
    gateway: z.string().nullish(),
    /** Giờ Việt Nam, dạng "2026-10-02 09:15:00". */
    transactionDate: z.string().nullish(),
    accountNumber: z.string().nullish(),
    content: z.string().nullish(),
    transferType: z.enum(['in', 'out']),
    transferAmount: z.coerce.number().int().min(0),
    referenceCode: z.string().nullish(),
  })
  .passthrough();
type SepayPayload = z.infer<typeof SepayPayload>;

const sha = (s: string) => createHash('sha256').update(s).digest();

/**
 * Nhận biến động số dư từ SePay: tiền vào tài khoản nhận tiền của nền tảng.
 *
 *   - Xác thực bằng khoá API SePay gửi trong header `Authorization: Apikey <khoá>`
 *     (cấu hình SEPAY_WEBHOOK_KEY). Chưa cấu hình = endpoint không tồn tại.
 *   - Khớp nội dung chuyển khoản + ĐÚNG số tiền -> tự tất toán hoá đơn, qua
 *     đúng saas_settle_invoice như nút bấm của người đối soát. Mọi trường hợp
 *     khác nằm ở /platform/invoices, mục "Giao dịch chưa khớp".
 *   - SePay gửi lại khi không nhận được 2xx. Gửi lại bao nhiêu lần cũng chỉ
 *     tính một (khoá theo mã giao dịch SePay).
 *
 * Không có @Platform(): người gọi là máy chủ SePay, không phải quản trị viên.
 * Vì vậy tệp này KHÔNG nằm dưới platform/ (mọi controller ở đó phải gắn
 * @Platform() — xem db-access-discipline.spec.ts).
 */
@Controller('webhooks')
export class SepayWebhookController {
  constructor(
    private readonly platform: PlatformService,
    private readonly cfg: ConfigService,
  ) {}

  @Public()
  @Post('sepay')
  @HttpCode(200)
  async sepay(
    @Headers('authorization') auth: string | undefined,
    @Body(new ZodPipe(SepayPayload)) body: SepayPayload,
  ): Promise<{ success: true; outcome: string }> {
    const key = this.cfg.get<string>('SEPAY_WEBHOOK_KEY');
    if (!key) throw new NotFoundException();

    // So băm cùng độ dài để không lộ độ dài khoá qua thời gian phản hồi.
    const got = /^apikey\s+(.+)$/i.exec(auth ?? '')?.[1]?.trim() ?? '';
    if (!timingSafeEqual(sha(got), sha(key))) throw new UnauthorizedException('INVALID_WEBHOOK_KEY');

    const r = await this.platform.ingestBankTxn({
      provider: 'SEPAY',
      txnId: String(body.id),
      direction: body.transferType === 'in' ? 'IN' : 'OUT',
      amount: body.transferAmount,
      content: body.content ?? '',
      accountNo: body.accountNumber ?? null,
      bankRef: body.referenceCode ?? null,
      txnAt: body.transactionDate ? `${body.transactionDate.trim().replace(' ', 'T')}+07:00` : null,
      payload: body,
    });
    return { success: true, outcome: r.outcome };
  }
}
