import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'kysely';
import type { Tx } from '../common/tenant-db.service';
import { requireContext } from '../common/tenant-context';

export type ResolvedPolicy = {
  policyId: string;
  salePct: number;
  teachMode: 'FIXED' | 'PCT';
  teachFixedAmount: number;
  teachPct: number;
  specificity: number;
};

export type AccruedCommission = {
  trainerId: string;
  trainerName: string;
  amount: number;
  ratePct: number | null;
};

/**
 * Mọi phép tính hoa hồng nằm ở đây, không rải ra các service nghiệp vụ.
 *
 * Hai loại, cả hai đều dùng:
 *   SALE  — % trên tiền THỰC THU, sinh khi ghi nhận một lần thu (kể cả hoàn tiền,
 *           khi đó số âm). Gắn với `payment` chứ không gắn với hoá đơn, nhờ đó
 *           trả góp tự động đúng tỉ lệ mà không cần công thức riêng.
 *   TEACH  — theo buổi đã dạy. Phase 3.
 */
@Injectable()
export class CommissionService {
  private readonly log = new Logger(CommissionService.name);

  /** Trả về `null` khi phòng tập chưa khai chính sách nào áp được. */
  async resolvePolicy(
    tx: Tx,
    trainerId: string,
    templateId: string | null,
    onDate: string,
  ): Promise<ResolvedPolicy | null> {
    const ctx = requireContext();
    const r = await sql<{
      policy_id: string;
      sale_pct: string;
      teach_mode: string;
      teach_fixed_amount: string;
      teach_pct: string;
      specificity: number;
    }>`SELECT * FROM resolve_commission_policy(
         ${ctx.tenantId}::uuid, ${trainerId}::uuid, ${templateId}::uuid, ${onDate}::date)`.execute(tx);

    const row = r.rows[0];
    if (!row) return null;
    return {
      policyId: row.policy_id,
      // numeric của Postgres về JS là CHUỖI. Number() ở đúng một chỗ này,
      // không để nó lọt ra ngoài dưới dạng string rồi bị nối chuỗi thay vì cộng.
      salePct: Number(row.sale_pct),
      teachMode: row.teach_mode as 'FIXED' | 'PCT',
      teachFixedAmount: Number(row.teach_fixed_amount),
      teachPct: Number(row.teach_pct),
      specificity: row.specificity,
    };
  }

  /**
   * Ghi hoa hồng bán hàng cho MỘT lần thu (hoặc hoàn) tiền.
   *
   * Chia tiền cho các hợp đồng trong hoá đơn theo TỈ LỆ giá trị từng dòng, rồi
   * gộp theo PT bán. Gộp là bắt buộc: `uq_comm_sale` là UNIQUE (payment_id,
   * trainer_id), nên hai hợp đồng cùng một người bán trong một hoá đơn phải ra
   * đúng một dòng hoa hồng.
   *
   * Phần dư của phép chia dồn vào hợp đồng CUỐI: chia đều rồi làm tròn từng
   * dòng sẽ lệch tổng vài đồng mỗi lần thu, và kế toán sẽ trả lại báo cáo.
   */
  async accrueForPayment(
    tx: Tx,
    args: { paymentId: string; invoiceId: string; signedAmount: number; paidAt: Date },
  ): Promise<AccruedCommission[]> {
    const ctx = requireContext();

    const items = await tx
      .selectFrom('invoice_item as ii')
      .innerJoin('member_package as mp', 'mp.id', 'ii.member_package_id')
      .innerJoin('trainer as t', 't.id', 'mp.sold_by_id')
      .innerJoin('identity as i', 'i.id', 't.identity_id')
      .select([
        'ii.id as itemId',
        'ii.amount as itemAmount',
        'mp.id as packageId',
        'mp.template_id as templateId',
        'mp.sold_by_id as trainerId',
        'i.full_name as trainerName',
      ])
      .where('ii.invoice_id', '=', args.invoiceId)
      .orderBy('ii.id')
      .execute();

    if (items.length === 0) return []; // hoá đơn không gắn hợp đồng nào có PT bán

    const tongDongGanPt = items.reduce((s, it) => s + Number(it.itemAmount), 0);
    if (tongDongGanPt === 0) return [];

    // Ngày phân giải chính sách = ngày THU tiền, theo giờ Việt Nam. Dùng ngày
    // hôm nay thay vì ngày thu sẽ tính sai khi nhập bù chứng từ của tháng trước.
    const ngay = new Date(args.paidAt).toLocaleDateString('en-CA', {
      timeZone: 'Asia/Ho_Chi_Minh',
    });

    const theoPt = new Map<string, { name: string; amount: number; pct: number | null }>();
    let daChia = 0;

    for (let i = 0; i < items.length; i++) {
      const it = items[i]!;
      const cuoi = i === items.length - 1;
      const phan = cuoi
        ? args.signedAmount - daChia
        : Math.round((args.signedAmount * Number(it.itemAmount)) / tongDongGanPt);
      daChia += phan;

      const policy = await this.resolvePolicy(tx, it.trainerId!, it.templateId, ngay);
      const tien = policy ? Math.round((phan * policy.salePct) / 100) : 0;

      if (!policy) {
        // KHÔNG chặn việc thu tiền vì một lỗ hổng cấu hình: tiền đã vào két rồi.
        // Ghi dòng 0 đồng có cờ `missing` để `v_commission_needs_policy` nhặt
        // lên thành việc phải xử lý, thay vì để nó biến mất không dấu vết.
        this.log.warn(
          `Không có chính sách hoa hồng cho PT ${it.trainerId} (gói ${it.templateId}) ngày ${ngay}`,
        );
      }

      const cu = theoPt.get(it.trainerId!);
      if (cu) cu.amount += tien;
      else
        theoPt.set(it.trainerId!, {
          name: it.trainerName,
          amount: tien,
          pct: policy?.salePct ?? null,
        });

      await tx
        .insertInto('commission_entry')
        .values({
          tenant_id: ctx.tenantId,
          trainer_id: it.trainerId!,
          kind: 'SALE',
          member_package_id: it.packageId,
          payment_id: args.paymentId,
          base_amount: phan,
          amount: tien,
          policy_snapshot: JSON.stringify(
            policy
              ? { ...policy, resolvedOn: ngay, allocatedFrom: it.itemId }
              : { missing: true, resolvedOn: ngay, allocatedFrom: it.itemId },
          ),
          earned_at: args.paidAt,
          period_month: sql`date_trunc('month', ${args.paidAt}::timestamptz
                            AT TIME ZONE 'Asia/Ho_Chi_Minh')::date`,
        })
        // Hai hợp đồng cùng PT trong một hoá đơn: cộng dồn vào dòng đã có thay
        // vì vỡ ở uq_comm_sale.
        .onConflict((oc) =>
          oc
            .columns(['payment_id', 'trainer_id'])
            .where('kind', '=', 'SALE')
            .doUpdateSet({
              base_amount: sql`commission_entry.base_amount + excluded.base_amount`,
              amount: sql`commission_entry.amount + excluded.amount`,
            }),
        )
        .execute();
    }

    return [...theoPt.entries()].map(([trainerId, v]) => ({
      trainerId,
      trainerName: v.name,
      amount: v.amount,
      ratePct: v.pct,
    }));
  }
}
