/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: { ignoreDuringBuilds: true },
  // A stray package-lock.json in a parent directory (C:\Users\Greg) makes Next
  // infer the wrong workspace root. Pin it so file tracing is deterministic.
  outputFileTracingRoot: __dirname,
};

module.exports = nextConfig;
