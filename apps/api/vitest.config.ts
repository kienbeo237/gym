import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.spec.ts', 'src/**/*.spec.ts'],
    // Test cách ly tenant dùng CHUNG một CSDL và đổi app.tenant_id trên từng
    // transaction; chạy song song sẽ tranh nhau. Ép một luồng.
    fileParallelism: false,
    testTimeout: 30_000,
    env: { TZ: 'Asia/Ho_Chi_Minh' },
  },
});
