'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

/** Chép một chuỗi vào clipboard, báo "Đã chép" hai giây. */
export function CopyButton({ text, label = 'Chép' }: { text: string; label?: string }) {
  const [xong, setXong] = useState(false);

  async function chep() {
    try {
      await navigator.clipboard.writeText(text);
      setXong(true);
      setTimeout(() => setXong(false), 2000);
    } catch {
      // Trình duyệt chặn clipboard (http, iframe): người dùng vẫn bôi đen chép tay được.
    }
  }

  return (
    <button type="button" className="btn btn-secondary btn-sm" onClick={() => void chep()}>
      {xong ? <Check size={14} /> : <Copy size={14} />}
      {xong ? 'Đã chép' : label}
    </button>
  );
}
