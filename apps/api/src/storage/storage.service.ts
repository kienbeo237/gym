import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import {
  FILE_RULES,
  type DownloadUrlResponse,
  type FileOwnerType,
  type UploadUrlRequest,
  type UploadUrlResponse,
} from '@pt/contracts';
import { TenantDb } from '../common/tenant-db.service';
import { requireContext } from '../common/tenant-context';

const UPLOAD_TTL = 300; // 5 phút để tải xong

/**
 * Tệp đi THẲNG từ trình duyệt lên S3, API chỉ ký URL.
 *
 * Không proxy tệp qua API: mười người cùng tải ảnh 15MB là 150MB nằm trong RAM
 * của tiến trình Node, và nó chết trước khi ai kịp nhận ra nguyên nhân.
 *
 * Quy trình ba bước — bước 3 là bước hay bị bỏ và nó là bước quan trọng nhất:
 *
 *   1. xin URL  -> ghi file_object PENDING, ký presigned PUT
 *   2. trình duyệt PUT thẳng lên S3
 *   3. xác nhận -> HeadObject để ĐỌC LẠI kích thước và kiểu thật từ S3
 *
 * Bỏ bước 3 thì mọi con số trong CSDL là do client khai. Client khai 1KB rồi
 * tải lên 2GB thì hạn mức trở thành trang trí, và không có cách nào biết dòng
 * nào là tệp thật, dòng nào là rác.
 */
@Injectable()
export class StorageService {
  private readonly log = new Logger(StorageService.name);
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(
    private readonly cfg: ConfigService,
    private readonly tdb: TenantDb,
  ) {
    this.bucket = cfg.getOrThrow('S3_BUCKET');
    this.s3 = new S3Client({
      region: cfg.get('S3_REGION') ?? 'us-east-1',
      endpoint: cfg.get('S3_ENDPOINT'),
      // Bắt buộc với MinIO/LocalStack: virtual-host style cần DNS ký tự đại diện.
      forcePathStyle: (cfg.get('S3_FORCE_PATH_STYLE') ?? 'true') === 'true',
      credentials: {
        accessKeyId: cfg.getOrThrow('S3_ACCESS_KEY'),
        secretAccessKey: cfg.getOrThrow('S3_SECRET_KEY'),
      },
    });
  }

  /**
   * Khoá S3 do MÁY CHỦ dựng, không bao giờ lấy từ client.
   *
   * Tiền tố `t/<tenantId>/` là lớp cách ly thứ hai, độc lập với RLS — và nó
   * được CHECK constraint `file_key_tenant_prefix` ép ở CSDL, nên một lỗi ở
   * đây vỡ ngay lúc ghi chứ không lặng lẽ đặt tệp vào thư mục phòng khác.
   *
   * Tên tệp người dùng đặt CHỈ dùng để lấy đuôi: nó chứa được `../`, ký tự
   * điều khiển, và tên của khách hàng khác.
   */
  private buildKey(tenantId: string, ownerType: FileOwnerType, fileName: string): string {
    const raw = extname(fileName).toLowerCase().replace(/[^.a-z0-9]/g, '');
    const ext = /^\.[a-z0-9]{1,8}$/.test(raw) ? raw : '';
    return `t/${tenantId}/${ownerType.toLowerCase()}/${randomUUID()}${ext}`;
  }

  async createUploadUrl(dto: UploadUrlRequest): Promise<UploadUrlResponse> {
    const ctx = requireContext();
    const rule = FILE_RULES[dto.ownerType];

    // Kiểm ở đây là để từ chối SỚM; con số thật vẫn đọc lại ở bước xác nhận.
    if (!rule.mimes.includes(dto.mime)) {
      throw new BadRequestException({
        code: 'FILE_MIME_NOT_ALLOWED',
        message: `Loại tệp không được chấp nhận. Cho phép: ${rule.mimes.join(', ')}`,
      });
    }
    if (dto.sizeBytes > rule.maxBytes) {
      throw new BadRequestException({
        code: 'FILE_TOO_LARGE',
        message: `Tệp vượt quá ${Math.round(rule.maxBytes / 1_000_000)}MB`,
      });
    }

    const objectKey = this.buildKey(ctx.tenantId, dto.ownerType, dto.fileName);

    const fileId = await this.tdb.run(async (tx) => {
      const row = await tx
        .insertInto('file_object')
        .values({
          tenant_id: ctx.tenantId,
          bucket: this.bucket,
          object_key: objectKey,
          mime: dto.mime,
          size_bytes: null,
          owner_type: dto.ownerType,
          owner_id: dto.ownerId ?? null,
          uploaded_by: ctx.identityId,
          status: 'PENDING',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return row.id;
    });

    const uploadUrl = await getSignedUrl(
      this.s3,
      new PutObjectCommand({ Bucket: this.bucket, Key: objectKey, ContentType: dto.mime }),
      { expiresIn: UPLOAD_TTL },
    );

    return { fileId, uploadUrl, objectKey, expiresInSeconds: UPLOAD_TTL };
  }

  /** Bước 3: đọc lại metadata THẬT từ S3. Không tin con số client khai. */
  async confirmUpload(fileId: string): Promise<{ sizeBytes: number; mime: string }> {
    const file = await this.tdb.run(async (tx) =>
      tx
        .selectFrom('file_object')
        .select(['id', 'object_key', 'owner_type', 'status'])
        .where('id', '=', fileId)
        .executeTakeFirst(),
    );
    if (!file) throw new NotFoundException('FILE_NOT_FOUND');
    if (file.status === 'CONFIRMED') {
      const cu = await this.tdb.run(async (tx) =>
        tx.selectFrom('file_object').select(['size_bytes', 'mime']).where('id', '=', fileId).executeTakeFirstOrThrow(),
      );
      return { sizeBytes: Number(cu.size_bytes), mime: cu.mime };
    }

    let head;
    try {
      head = await this.s3.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: file.object_key }),
      );
    } catch {
      await this.tdb.run(async (tx) => {
        await tx.updateTable('file_object').set({ status: 'FAILED' }).where('id', '=', fileId).execute();
      });
      throw new BadRequestException({
        code: 'FILE_NOT_UPLOADED',
        message: 'Chưa thấy tệp trên kho lưu trữ. Vui lòng tải lên rồi thử lại.',
      });
    }

    const sizeBytes = Number(head.ContentLength ?? 0);
    const mime = head.ContentType ?? 'application/octet-stream';
    const rule = FILE_RULES[file.owner_type as FileOwnerType];

    // Kích thước thật vượt hạn mức: xoá khỏi S3 luôn. Để lại là trả tiền lưu
    // trữ cho một tệp không bao giờ dùng tới.
    if (sizeBytes > rule.maxBytes) {
      await this.s3
        .send(new DeleteObjectCommand({ Bucket: this.bucket, Key: file.object_key }))
        .catch((e: unknown) => this.log.warn(`Không xoá được tệp quá cỡ: ${String(e)}`));
      await this.tdb.run(async (tx) => {
        await tx.updateTable('file_object').set({ status: 'FAILED' }).where('id', '=', fileId).execute();
      });
      throw new BadRequestException({
        code: 'FILE_TOO_LARGE',
        message: `Tệp thực tế ${Math.round(sizeBytes / 1_000_000)}MB, vượt quá ${Math.round(rule.maxBytes / 1_000_000)}MB`,
      });
    }

    await this.tdb.run(async (tx) => {
      await tx
        .updateTable('file_object')
        .set({ status: 'CONFIRMED', confirmed_at: new Date(), size_bytes: sizeBytes, mime })
        .where('id', '=', fileId)
        .execute();
    });

    return { sizeBytes, mime };
  }

  /**
   * URL tải về, hạn ngắn theo loại tệp.
   *
   * RLS lo phần "tệp này có thuộc phòng đang mở không" — truy vấn dưới đây
   * không thấy dòng của phòng khác, nên không ký được URL cho nó.
   */
  async createDownloadUrl(fileId: string): Promise<DownloadUrlResponse> {
    const file = await this.tdb.run(async (tx) =>
      tx
        .selectFrom('file_object')
        .select(['object_key', 'owner_type', 'status'])
        .where('id', '=', fileId)
        .executeTakeFirst(),
    );
    if (!file || file.status !== 'CONFIRMED') throw new NotFoundException('FILE_NOT_FOUND');

    const ttl = FILE_RULES[file.owner_type as FileOwnerType].downloadTtlSeconds;
    const url = await getSignedUrl(
      this.s3,
      new GetObjectCommand({ Bucket: this.bucket, Key: file.object_key }),
      { expiresIn: ttl },
    );
    return { url, expiresInSeconds: ttl };
  }

  /**
   * Dọn tệp mồ côi: dòng PENDING quá hạn ký URL nhiều lần.
   *
   * Xoá trên S3 TRƯỚC rồi mới xoá dòng CSDL. Ngược lại thì mất dấu khoá và tệp
   * nằm lại trong bucket vĩnh viễn, không ai biết nó thuộc về đâu.
   */
  async cleanupOrphans(olderThanHours = 24): Promise<{ deleted: number }> {
    const rows = await this.tdb.run(async (tx) =>
      tx
        .selectFrom('file_object')
        .select(['id', 'object_key'])
        .where('status', '=', 'PENDING')
        .where('created_at', '<', new Date(Date.now() - olderThanHours * 3600_000))
        .limit(500)
        .execute(),
    );

    let deleted = 0;
    for (const r of rows) {
      await this.s3
        .send(new DeleteObjectCommand({ Bucket: this.bucket, Key: r.object_key }))
        .catch(() => undefined); // tệp chưa từng được tải lên là ca thường nhất
      await this.tdb.run(async (tx) => {
        await tx.deleteFrom('file_object').where('id', '=', r.id).execute();
      });
      deleted++;
    }
    return { deleted };
  }
}
