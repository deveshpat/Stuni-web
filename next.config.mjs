/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config, { isServer }) => {
    // These browser-incompatible native modules are only needed on the server
    // (onnxruntime-node is used by @xenova/transformers in the TTS API route).
    // Excluding them from the client bundle prevents bundling errors while
    // still allowing the server-side API routes to use them normally.
    if (!isServer) {
      config.resolve.alias["onnxruntime-node"] = false;
      config.resolve.alias.sharp = false;
    }
    return config;
  },
};

export default nextConfig;
