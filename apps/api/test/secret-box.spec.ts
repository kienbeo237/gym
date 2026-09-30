/**
 * Niêm phong bí mật theo phòng tập (common/secret-box.ts).
 *
 * Thứ cần chứng minh không phải "mã hoá rồi giải mã được" — cái đó thư viện lo.
 * Thứ cần chứng minh là bản mã BỊ TRÓI vào đúng phòng và đúng mục đích: chép
 * sang phòng khác, tráo cột, hay sửa một byte đều phải THẤT BẠI, không được
 * âm thầm ra một giá trị.
 */
import { describe, expect, it } from 'vitest';
import { moNiemPhong, niemPhong } from '../src/common/secret-box';

const KHOA = 'khoa-goc-chi-dung-trong-test-0123456789';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('secret-box', () => {
  it('mở lại được đúng giá trị ở đúng phòng, đúng mục đích', () => {
    const goi = niemPhong(KHOA, A, 'zalo.secret', 'bi-mat-cua-OA');
    expect(moNiemPhong(KHOA, A, 'zalo.secret', goi)).toBe('bi-mat-cua-OA');
  });

  it('hai lần niêm phong cùng giá trị cho hai bản mã khác nhau (iv ngẫu nhiên)', () => {
    const x = niemPhong(KHOA, A, 'zalo.secret', 'v');
    const y = niemPhong(KHOA, A, 'zalo.secret', 'v');
    expect(x.equals(y)).toBe(false);
  });

  it('chép bản mã của phòng A sang phòng B -> THẤT BẠI', () => {
    const goi = niemPhong(KHOA, A, 'zalo.refresh', 'refresh-token-cua-A');
    expect(() => moNiemPhong(KHOA, B, 'zalo.refresh', goi)).toThrow();
  });

  it('tráo cột (refresh token vào chỗ secret) -> THẤT BẠI', () => {
    const goi = niemPhong(KHOA, A, 'zalo.refresh', 'x');
    expect(() => moNiemPhong(KHOA, A, 'zalo.secret', goi)).toThrow();
  });

  it('sửa một byte bản mã -> THẤT BẠI', () => {
    const goi = niemPhong(KHOA, A, 'otp.code', '482913');
    goi[goi.length - 1] = goi[goi.length - 1]! ^ 0x01;
    expect(() => moNiemPhong(KHOA, A, 'otp.code', goi)).toThrow();
  });

  it('sai khoá gốc -> THẤT BẠI', () => {
    const goi = niemPhong(KHOA, A, 'otp.code', '482913');
    expect(() => moNiemPhong(`${KHOA}-khac`, A, 'otp.code', goi)).toThrow();
  });

  it('bản mã không nhận ra định dạng -> ném lỗi rõ ràng', () => {
    expect(() => moNiemPhong(KHOA, A, 'otp.code', Buffer.from('rac'))).toThrow(/FORMAT/);
  });
});
