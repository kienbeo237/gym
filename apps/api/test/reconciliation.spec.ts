/**
 * CỔNG GÁC ĐỐI SOÁT.
 *
 * Bốn view `v_*_drift` / `v_*_needs_*` là lớp kiểm tra cuối cùng cho mọi đại
 * lượng có bản cache: số dư buổi tập, số buổi đã dùng, tiền đã thu, hoa hồng
 * bán hàng. Chúng phải RỖNG.
 *
 * Vì sao chạy trong test chứ không chỉ để job đêm gọi: một view chỉ chạy lúc
 * 2 giờ sáng trên môi trường thật là một view không ai đọc kết quả. Ở đây nó
 * đỏ ngay trong build, và nó ĐÃ bắt được một lỗi thật — công thức đối soát cũ
 * trộn "số dư" với "số buổi đã dùng", nên hợp đồng bị huỷ báo lệch -10 trong
 * khi cả hai con số đều đúng (xem migration 0010).
 *
 * Test này CẦN dữ liệu: chạy sau `pnpm db:seed`. Không có dữ liệu thì nó xanh
 * một cách vô nghĩa — nên có một ca riêng đòi phải có ít nhất vài hợp đồng.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { Client } from 'pg';
import { resolve } from 'node:path';

config({ path: resolve(__dirname, '../../../.env') });

const VIEWS = [
  ['v_session_balance_drift', 'Số dư hoặc số buổi đã dùng lệch khỏi sổ cái'],
  ['v_invoice_paid_drift', 'Tiền đã thu trên hoá đơn lệch khỏi tổng các lần thu'],
  ['v_sale_commission_drift', 'Lần thu tiền không có đúng một dòng hoa hồng bán hàng'],
  ['v_commission_needs_policy', 'Hoa hồng ghi 0 đồng vì không phân giải được chính sách'],
] as const;

let db: Client;

beforeAll(async () => {
  db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
});
afterAll(async () => {
  await db.end().catch(() => {});
});

describe('Đối soát tiền và buổi tập', () => {
  it('có dữ liệu để đối soát (chống test xanh vô nghĩa)', async () => {
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM member_package`,
    );
    expect(
      Number(rows[0]!.n),
      'Không có hợp đồng nào. Chạy `pnpm db:seed` trước.',
    ).toBeGreaterThan(0);
  });

  it.each(VIEWS)('%s rỗng', async (view, moTa) => {
    const { rows } = await db.query(`SELECT * FROM ${view} LIMIT 20`);
    expect(
      rows,
      `${moTa}.\n` +
        `Đây là lệch dữ liệu THẬT, không phải test hỏng — đừng nới phép kiểm.\n` +
        `Xem chi tiết: SELECT * FROM ${view};\n` +
        JSON.stringify(rows, null, 2),
    ).toEqual([]);
  });

  it('bộ đối soát KHÔNG rỗng: một lệch giả lập bị bắt', async () => {
    // Test âm. Không có ca này thì một view viết sai điều kiện HAVING (luôn trả
    // rỗng) cũng làm mọi thứ xanh, và cả bốn cổng gác trên thành trang trí.
    await db.query('BEGIN');
    try {
      await db.query(`
        UPDATE member_package
           SET sessions_used = sessions_used + 3
         WHERE id = (SELECT id FROM member_package ORDER BY created_at LIMIT 1)`);
      const { rows } = await db.query(`SELECT * FROM v_session_balance_drift`);
      expect(rows.length).toBeGreaterThan(0);
    } finally {
      await db.query('ROLLBACK');
    }
  });

  it('số dư không âm, và không vượt số buổi của hợp đồng cộng buổi tặng', async () => {
    const { rows } = await db.query<{ code: string; sessions_remaining: number }>(
      `SELECT code, sessions_remaining FROM member_package WHERE sessions_remaining < 0`,
    );
    expect(rows, `Số dư âm — CHECK mp_remaining_nonneg đã bị bỏ qua ở đâu đó`).toEqual([]);
  });

  it('mọi hợp đồng đều có dòng sổ cái PURCHASE', async () => {
    // Bán gói mà quên ghi sổ cái thì hội viên có hợp đồng nhưng không tập được,
    // và không có gì báo lỗi — chỉ có nút điểm danh im lặng từ chối.
    const { rows } = await db.query<{ code: string }>(`
      SELECT mp.code FROM member_package mp
      WHERE NOT EXISTS (
        SELECT 1 FROM session_ledger sl
        WHERE sl.member_package_id = mp.id AND sl.reason = 'PURCHASE')`);
    expect(rows.map((r) => r.code), 'Hợp đồng không có dòng sổ cái PURCHASE').toEqual([]);
  });

  it('mọi hoá đơn đều khớp tổng các dòng hàng', async () => {
    // GROUP BY phải theo `i.id`, KHÔNG theo `i.code`.
    //
    // Kết nối này chạy bằng pt_migrator (thấy mọi tenant, đúng ý đồ cho việc
    // đối soát toàn hệ thống), mà mã hoá đơn chỉ duy nhất TRONG một phòng tập —
    // `uq_invoice_code` là UNIQUE (tenant_id, code). Gộp theo mã sẽ cộng chung
    // hoá đơn của hai phòng khác nhau và báo lệch giả.
    //
    // Đây đúng là lớp lỗi mà cổng gác C (UNIQUE phải có tenant_id) tồn tại để
    // chặn ở schema; ở tầng truy vấn thì phải tự nhớ.
    const { rows } = await db.query<{ id: string; code: string; total: string; items: string }>(`
      SELECT i.id, i.code, i.total_amount::text AS total,
             COALESCE(SUM(it.amount), 0)::text AS items
      FROM invoice i
      LEFT JOIN invoice_item it ON it.invoice_id = i.id
      WHERE i.status <> 'VOID'
      GROUP BY i.id, i.code, i.total_amount
      HAVING i.total_amount <> COALESCE(SUM(it.amount), 0)`);
    expect(rows, 'Tổng hoá đơn không bằng tổng các dòng hàng').toEqual([]);
  });

  it('hoá đơn trả góp: tổng các đợt bằng tổng hoá đơn', async () => {
    const { rows } = await db.query<{ code: string }>(`
      SELECT i.code FROM invoice i
      WHERE i.is_installment AND i.status <> 'VOID'
        AND i.total_amount <> (
          SELECT COALESCE(SUM(ps.amount), 0) FROM payment_schedule ps
          WHERE ps.invoice_id = i.id)`);
    expect(
      rows.map((r) => r.code),
      'Tổng các đợt trả góp không bằng tổng hoá đơn — trigger trg_installment_total đã bị bỏ qua',
    ).toEqual([]);
  });
});
