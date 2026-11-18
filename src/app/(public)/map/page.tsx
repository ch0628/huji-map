import React, { Suspense } from "react";
import AppShell from "@/components/layout/AppShell";
import MapDiscoveryClient from "@/components/map/MapDiscoveryClient";
import type { RestroomFilterType } from "@/components/map/MapFilterBar";

interface MapPageProps {
  searchParams?: Promise<{
    restroomId?: string;
    type?: string;
  }>;
}

export default async function MapPage({ searchParams }: MapPageProps) {
  const resolvedParams = searchParams ? await searchParams : {};
  const initialRestroomId =
    typeof resolvedParams.restroomId === "string"
      ? resolvedParams.restroomId
      : undefined;
  const rawType = resolvedParams.type;
  const initialFilterType: RestroomFilterType =
    rawType === "public" || rawType === "partner" ? rawType : "all";

  return (
    <AppShell headerTitle="화장실 지도">
      <div className="relative flex flex-1 flex-col h-[calc(100vh-90px)] min-h-[500px] -m-4 overflow-hidden">
        <Suspense
          fallback={
            <div className="flex flex-1 items-center justify-center p-8 text-xs text-slate-500">
              지도 로딩 중...
            </div>
          }
        >
          <MapDiscoveryClient
            initialRestroomId={initialRestroomId}
            initialFilterType={initialFilterType}
          />
        </Suspense>
      </div>
    </AppShell>
  );
}

