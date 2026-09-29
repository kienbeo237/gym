import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // @pt/contracts xuất ESM/CJS từ workspace -> Next phải tự biên dịch.
  transpilePackages: ['@pt/contracts'],
};

export default config;
