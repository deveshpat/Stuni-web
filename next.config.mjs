/** @type {import('next').NextConfig} */
const nextConfig = {
  // Required for SharedArrayBuffer used by WebLLM (WebGPU) and Transformers.js (WASM)
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
        ],
      },
    ];
  },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      // Exclude Node.js-only packages and native bindings from the browser bundle
      config.resolve.alias = {
        ...config.resolve.alias,
        // Tell webpack to ignore the Node.js ONNX runtime (browser uses onnxruntime-web)
        "onnxruntime-node$": false,
        // Ignore sharp (server-side image processing)
        "sharp$": false,
      };
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        crypto: false,
        stream: false,
        os: false,
      };
    }
    // Ignore native .node binary files
    config.module.rules.push({
      test: /\.node$/,
      use: "null-loader",
    });
    // Enable async WebAssembly
    config.experiments = {
      ...config.experiments,
      asyncWebAssembly: true,
    };
    return config;
  },
};

export default nextConfig;
