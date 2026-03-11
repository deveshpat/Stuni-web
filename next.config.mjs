/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config) => {
    config.resolve.alias["onnxruntime-node"] = false;
    config.resolve.alias.sharp = false;
    return config;
  },
};

export default nextConfig;
