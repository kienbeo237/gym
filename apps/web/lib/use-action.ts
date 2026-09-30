'use client';

import { useState } from 'react';
import { thongBaoLoi } from './client-api';

/**
 * Trạng thái của một nút gửi: đang chạy / câu lỗi. Mọi form ghi dữ liệu đều
 * cần đúng ba thứ này — viết lại mỗi nơi là mỗi nơi quên một nhánh.
 */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [loi, setLoi] = useState('');

  async function chay<T>(fn: () => Promise<T>): Promise<T | undefined> {
    setBusy(true);
    setLoi('');
    try {
      return await fn();
    } catch (e) {
      setLoi(thongBaoLoi(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }

  return { busy, loi, setLoi, chay };
}

/** Khoá chống ghi trùng, sinh lúc MỞ form (xem RecordPaymentRequest.idempotencyKey). */
export const khoaMoi = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
