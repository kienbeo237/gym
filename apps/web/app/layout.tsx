import type { Metadata, Viewport } from 'next';
import { Be_Vietnam_Pro } from 'next/font/google';
// Kiểu gốc của lịch chọn ngày TRƯỚC globals.css: globals chỉ đổi biến của nó.
import 'react-day-picker/style.css';
import './globals.css';

// Font thiết kế cho tiếng Việt: dấu chồng (ặ, ỗ, ữ) không đè lên dòng trên như
// nhiều font Latin. next/font tự host tệp font lúc build — không gọi Google
// lúc người dùng mở trang.
const font = Be_Vietnam_Pro({
  subsets: ['latin', 'vietnamese'],
  weight: ['400', '500', '600', '700', '800'],
  display: 'swap',
  variable: '--font-sans',
});

export const metadata: Metadata = {
  title: { default: 'PT Studio — Quản lý hội viên', template: '%s · PT Studio' },
  description: 'Hệ thống quản lý hội viên, gói tập và lịch tập cho phòng tập cá nhân',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0b0e14' },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi" className={font.variable}>
      <body>{children}</body>
    </html>
  );
}
