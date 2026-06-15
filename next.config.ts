import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Include the vendored rated-wallets dataset in serverless function bundles
  // (read at request time by rated-wallets-service via process.cwd()).
  outputFileTracingIncludes: {
    '/**': ['./data/backups/wallet-rating/**/*'],
  },
};

export default nextConfig;
