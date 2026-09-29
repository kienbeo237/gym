import path from 'node:path';
import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // @pt/contracts xuất ESM/CJS từ workspace -> Next phải tự biên dịch.
  transpilePackages: ['@pt/contracts'],
  // Image Docker chỉ chép `.next/standalone` (server.js + node_modules tối thiểu).
  // Trong monorepo phải chỉ gốc repo, không thì bỏ sót gói workspace khi trace.
  output: 'standalone',
  outputFileTracingRoot: path.join(__dirname, '../..'),
};

export default config;
