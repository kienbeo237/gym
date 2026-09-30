import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

/**
 * Mã hoá bí mật của TỪNG PHÒNG TẬP (secret Zalo OA, token, mã OTP chờ gửi).
 *
 * AES-256-GCM, khoá DẪN XUẤT riêng cho mỗi phòng bằng HKDF từ TENANT_SECRET_KEY:
 *
 *   khoá_phòng = HKDF-SHA256(TENANT_SECRET_KEY, salt = tenant_id, info = phiên bản)
 *
 * Và `mục đích` (zalo.secret / zalo.refresh / ...) đi vào AAD. Hai ràng buộc đó
 * chặn hai kiểu tấn công mà mã hoá "một khoá chung" không chặn được:
 *
 *  1. Chép bản mã của phòng A sang dòng của phòng B (ai đó có quyền ghi CSDL,
 *     hoặc một lỗi UPDATE thiếu điều kiện) -> giải mã THẤT BẠI, không âm thầm
 *     gửi tin bằng OA của phòng khác.
 *  2. Tráo cột trong cùng một dòng (refresh token vào chỗ secret) -> thất bại.
 *
 * Định dạng: [phiên bản 1B][iv 12B][tag 16B][bản mã]. Byte phiên bản để về sau
 * xoay khoá được mà không phải đoán bản ghi cũ dùng khoá nào.
 *
 * KHÔNG phải một service Nest: là hàm thuần để test gọi thẳng, và để không ai
 * tiêm nhầm nó vào nơi không nên cầm khoá.
 */
const PHIEN_BAN = 1;
const INFO = Buffer.from('pt/tenant-secret/v1');

export type MucDich = 'zalo.secret' | 'zalo.access' | 'zalo.refresh' | 'zalo.webhook' | 'otp.code';

function khoaPhong(masterKey: string, tenantId: string): Buffer {
  if (!masterKey) throw new Error('TENANT_SECRET_KEY chưa đặt');
  // HKDF nhận khoá gốc ở dạng bất kỳ — không cần base64 hợp lệ, nên giá trị dev
  // trong .env.example vẫn chạy (config-guard chặn nó ở môi trường thật).
  return Buffer.from(hkdfSync('sha256', Buffer.from(masterKey, 'utf8'), Buffer.from(tenantId), INFO, 32));
}

function aad(tenantId: string, mucDich: MucDich): Buffer {
  return Buffer.from(`${tenantId}|${mucDich}`);
}

export function niemPhong(masterKey: string, tenantId: string, mucDich: MucDich, banRo: string): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', khoaPhong(masterKey, tenantId), iv);
  c.setAAD(aad(tenantId, mucDich));
  const ct = Buffer.concat([c.update(banRo, 'utf8'), c.final()]);
  return Buffer.concat([Buffer.from([PHIEN_BAN]), iv, c.getAuthTag(), ct]);
}

export function moNiemPhong(masterKey: string, tenantId: string, mucDich: MucDich, goi: Buffer): string {
  if (goi.length < 1 + 12 + 16 || goi[0] !== PHIEN_BAN) {
    throw new Error('SECRET_BOX_FORMAT');
  }
  const iv = goi.subarray(1, 13);
  const tag = goi.subarray(13, 29);
  const d = createDecipheriv('aes-256-gcm', khoaPhong(masterKey, tenantId), iv);
  d.setAAD(aad(tenantId, mucDich));
  d.setAuthTag(tag);
  // Sai phòng / sai mục đích / bị sửa -> final() ném lỗi. Cố ý để nó ném.
  return Buffer.concat([d.update(goi.subarray(29)), d.final()]).toString('utf8');
}
