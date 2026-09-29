import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'PT — Quản lý hội viên',
  description: 'Hệ thống quản lý hội viên, gói tập và lịch tập cho phòng tập cá nhân',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi">
      <body style={{ margin: 0, fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif' }}>
        {children}
      </body>
    </html>
  );
}
