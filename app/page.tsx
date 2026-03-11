"use client";

import dynamic from "next/dynamic";

const VideoGenerator = dynamic(() => import("@/components/VideoGenerator"), {
  ssr: false,
  loading: () => (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center">
      <p className="text-gray-500 text-sm">Loading Stuni...</p>
    </div>
  ),
});

export default function Home() {
  return <VideoGenerator />;
}
