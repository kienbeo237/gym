import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TenantDb } from '../common/tenant-db.service';
import { requestContext } from '../common/tenant-context';
import { RateLimitService } from '../redis/rate-limit.service';
import { globalKey, tenantKey } from '../redis/redis-keys';
import { OutboxDispatcher } from '../notification/outbox-dispatcher.service';
import { CampaignRunner } from '../notification/campaign-runner.service';
import { ZaloOaService } from '../zalo/zalo-oa.service';
import { StorageService } from '../storage/storage.service';
import { PlatformDb } from '../platform/platform-db.service';
import { BookingService } from '../attendance/booking.service';
import { StaffReminderService } from '../inbox/staff-reminder.service';

/** Tệp nhịp tim — HEALTHCHECK của container kiểm độ mới của nó. */
export const TEP_NHIP_TIM = join(tmpdir(), 'pt-worker.alive');

const PHUT = 60_000;
const TZ = 'Asia/Ho_Chi_Minh';

type Job = { ten: string; moiMs: number; chay: () => Promise<number | void> };

/**
 * Lịch chạy của worker. Không cron, không BullMQ — vì sao:
 *
 *  - gửi tin: hàng đợi CHÍNH LÀ bảng outbox (xem migration 0015)
 *  - job định kỳ: vòng setTimeout + KHOÁ REDIS. Chạy nhiều bản worker thì mỗi
 *    job vẫn chỉ một bản chạy tại một thời điểm; một bản chết thì khoá hết hạn
 *    và bản khác nhận.
 *
 * Mỗi job TỰ AN TOÀN khi chạy lặp (idempotent) — khoá chỉ để đỡ phí công,
 * không phải lớp đúng/sai. Riêng làm mới token Zalo thì khoá là lớp đúng/sai,
 * và nó nằm ngay trong ZaloOaService, không phụ thuộc lịch chạy ở đây.
 */
@Injectable()
export class Scheduler implements OnApplicationShutdown {
  private readonly log = new Logger('Scheduler');
  private dung = false;
  private readonly timers = new Set<NodeJS.Timeout>();
  private readonly dangChay = new Set<Promise<unknown>>();

  constructor(
    private readonly tdb: TenantDb,
    private readonly rate: RateLimitService,
    private readonly dispatcher: OutboxDispatcher,
    private readonly campaigns: CampaignRunner,
    private readonly oa: ZaloOaService,
    private readonly storage: StorageService,
    private readonly platform: PlatformDb,
    private readonly bookings: BookingService,
    private readonly nhacLich: StaffReminderService,
  ) {}

  start(): void {
    const jobs: Job[] = [
      // Gửi tin: nhịp ngắn; lô đầy thì chạy tiếp ngay không chờ.
      { ten: 'outbox', moiMs: 3_000, chay: () => this.dispatcher.tick() },
      { ten: 'zalo-token', moiMs: 30 * PHUT, chay: () => this.moiPhong('zalo-token', 25 * 60, (t) => this.oa.refreshIfExpiringSoon(t)) },
      { ten: 'campaign', moiMs: 30 * PHUT, chay: () => this.chienDich() },
      { ten: 'report-refresh', moiMs: 15 * PHUT, chay: () => this.baoCao() },
      { ten: 'file-cleanup', moiMs: 60 * PHUT, chay: () => this.moiPhong('file-cleanup', 50 * 60, (t) => this.donTep(t)) },
      { ten: 'saas-lifecycle', moiMs: 60 * PHUT, chay: () => this.vongDoiThueBao() },
      // Đóng buổi đã tập xong; tự đánh vắng (chỉ phòng bật auto_no_show).
      { ten: 'booking-sweep', moiMs: 15 * PHUT, chay: () => this.moiPhong('booking-sweep', 12 * 60, (t) => this.quetBuoi(t)) },
      { ten: 'reconcile', moiMs: 6 * 60 * PHUT, chay: () => this.doiSoat() },
      // Chuông thông báo nhân viên: nhắc HLV trước 30', lịch dạy 7h, buổi trễ chưa điểm danh.
      { ten: 'staff-remind', moiMs: 5 * PHUT, chay: () => this.moiPhong('staff-remind', 4 * 60, (t) => this.nhacNhanVien(t)) },
    ];
    for (const j of jobs) this.lap(j, j.ten === 'outbox' ? 500 : 10_000);
    this.log.log(`Worker chạy ${jobs.length} job: ${jobs.map((j) => j.ten).join(', ')}`);
  }

  private lap(j: Job, treMs: number): void {
    if (this.dung) return;
    const t = setTimeout(() => {
      this.timers.delete(t);
      const p = (async () => {
        let ketQua: number | void = undefined;
        try {
          ketQua = await j.chay();
        } catch (e) {
          this.log.error(`Job ${j.ten} lỗi: ${String(e)}`);
        }
        if (j.ten === 'outbox') await writeFile(TEP_NHIP_TIM, String(Date.now())).catch(() => undefined);
        // outbox lấy đủ lô = còn việc: chạy lại ngay.
        this.lap(j, j.ten === 'outbox' && typeof ketQua === 'number' && ketQua >= 50 ? 0 : j.moiMs);
      })();
      this.dangChay.add(p);
      void p.finally(() => this.dangChay.delete(p));
    }, treMs);
    this.timers.add(t);
  }

  /** Chạy `fn` cho từng phòng, mỗi phòng dưới một khoá riêng. */
  private async moiPhong(ten: string, khoaGiay: number, fn: (tenantId: string) => Promise<unknown>): Promise<void> {
    for (const tenantId of await this.tdb.workerTenantIds()) {
      if (this.dung) return;
      const nha = await this.rate.acquire(tenantKey(tenantId, 'job', ten), khoaGiay).catch(() => null);
      if (!nha) continue;
      try {
        await fn(tenantId);
      } catch (e) {
        this.log.error(`Job ${ten} ở phòng ${tenantId} lỗi: ${String(e)}`);
      } finally {
        await nha();
      }
    }
  }

  /** Chiến dịch chỉ chạy trong giờ hành chính — không ai muốn nhận tin nhắc gia hạn lúc 2 giờ sáng. */
  private async chienDich(): Promise<void> {
    const gio = Number(new Date().toLocaleString('en-US', { timeZone: TZ, hour: 'numeric', hour12: false })) % 24;
    if (gio < 9 || gio >= 20) return;
    await this.moiPhong('campaign', 25 * 60, (t) => this.campaigns.runTenant(t));
  }

  private async baoCao(): Promise<void> {
    const nha = await this.rate.acquire(globalKey('job', 'report-refresh'), 10 * 60).catch(() => null);
    if (!nha) return;
    try {
      await this.tdb.refreshReporting();
    } finally {
      await nha();
    }
  }

  /**
   * Vòng đời thuê bao SaaS: phát hành hoá đơn kỳ tới, chuyển quá hạn, tạm khoá.
   * Toàn bộ luật nằm trong hàm SQL saas_lifecycle_tick (0016); job chỉ gọi nó.
   * Khoá toàn cục vì hàm quét MỌI phòng trong một lần.
   */
  private async vongDoiThueBao(): Promise<void> {
    const nha = await this.rate.acquire(globalKey('job', 'saas-lifecycle'), 10 * 60).catch(() => null);
    if (!nha) return;
    try {
      const kq = await this.platform.lifecycleTick();
      if (Object.values(kq).some((n) => Number(n) > 0)) this.log.log(`Vòng đời thuê bao: ${JSON.stringify(kq)}`);
    } finally {
      await nha();
    }
  }

  /** Chạy trong ngữ cảnh "chỉ có tenant" như donTep — người thực hiện ghi NULL (hệ thống). */
  private async quetBuoi(tenantId: string): Promise<void> {
    const kq = await requestContext.run(
      { tenantId, identityId: '', roles: [], requestId: `worker-${randomUUID()}` },
      () => this.bookings.sweep(),
    );
    if (kq.completed || kq.noShow || kq.failed) this.log.log(`Quét buổi tập phòng ${tenantId}: ${JSON.stringify(kq)}`);
  }

  private async nhacNhanVien(tenantId: string): Promise<void> {
    const kq = await requestContext.run(
      { tenantId, identityId: '', roles: [], requestId: `worker-${randomUUID()}` },
      () => this.nhacLich.tick(),
    );
    if (kq.upcoming || kq.agenda || kq.unchecked) this.log.log(`Nhắc lịch phòng ${tenantId}: ${JSON.stringify(kq)}`);
  }

  /**
   * Tám view đối soát trên dữ liệu thật. Có lệch là LỖI hệ thống: ghi log mức
   * error (để cảnh báo log bắt được) và lưu reconciliation_run — trang tổng
   * quan nền tảng hiện báo động đỏ từ bảng đó.
   */
  private async doiSoat(): Promise<void> {
    const nha = await this.rate.acquire(globalKey('job', 'reconcile'), 30 * 60).catch(() => null);
    if (!nha) return;
    try {
      const kq = await this.platform.reconcile();
      const loi = Object.keys(kq.errors);
      if (kq.total > 0 || loi.length > 0) {
        const lech = Object.entries(kq.counts).filter(([, n]) => n > 0).map(([v, n]) => `${v}=${n}`);
        this.log.error(`ĐỐI SOÁT LỆCH: ${lech.join(', ') || 'không'}; view lỗi: ${loi.join(', ') || 'không'}`);
      } else {
        this.log.log('Đối soát: tám view rỗng');
      }
    } finally {
      await nha();
    }
  }

  /**
   * StorageService dùng TenantDb.run() — đọc tenant từ ngữ cảnh request. Worker
   * dựng một ngữ cảnh CHỈ có tenant và không có vai trò nào: đủ cho RLS, và mọi
   * phép kiểm quyền theo vai trò sẽ từ chối thay vì cho qua.
   */
  private donTep(tenantId: string) {
    return requestContext.run(
      { tenantId, identityId: '', roles: [], requestId: `worker-${randomUUID()}` },
      () => this.storage.cleanupOrphans(24),
    );
  }

  async onApplicationShutdown(): Promise<void> {
    this.dung = true;
    for (const t of this.timers) clearTimeout(t);
    // Chờ lô đang dở làm nốt: bỏ ngang thì các dòng SENDING phải đợi hết lease.
    await Promise.race([Promise.allSettled([...this.dangChay]), new Promise((r) => setTimeout(r, 15_000))]);
    this.log.log('Worker đã dừng');
  }
}
