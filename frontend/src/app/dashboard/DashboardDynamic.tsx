"use client";

import dynamic from "next/dynamic";

const DashboardPageClient = dynamic(() => import("./DashboardPageClient"), {
  ssr: false,
  loading: () => (
    <main
      className="min-h-[100dvh] bg-[#200100]"
      aria-busy="true"
      aria-label="Loading dashboard"
    />
  ),
});

export default function DashboardDynamic() {
  return <DashboardPageClient />;
}
