import React from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import AppShell from "@/components/layout/AppShell";
import RestroomDetailClient from "./RestroomDetailClient";
import { isSupabaseAuthConfigured } from "@/lib/auth";
import {
  isE2eMockEnvironmentEnabled,
  isE2eMockSessionAllowed,
} from "@/lib/auth/mock-guard";
import { createServerClientInstance } from "@/lib/supabase/server";
import { getPublicRestroomDetail } from "@/lib/restrooms";
import { getLatestActiveCustomerAccessForRestroom } from "@/components/access/access-server";
import type { CustomerAccessDetail } from "@/components/access/types";

interface RestroomDetailPageProps {
  params: Promise<{ id: string }>;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export default async function RestroomDetailPage({
  params,
}: RestroomDetailPageProps) {
  const { id } = await params;

  if (!id || !UUID_REGEX.test(id)) {
    return notFound();
  }

  // Supabase 미설정 환경 대비 (E2E Mock 환경 제외 — 공용 보안 가드 사용)
  const isE2eMockEnabled = isE2eMockEnvironmentEnabled();

  if (!isSupabaseAuthConfigured() && !isE2eMockEnabled) {
    return (
      <AppShell headerTitle="화장실 상세">
        <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
          <div className="mb-3 text-4xl">⚙️</div>
          <h2 className="text-base font-bold text-slate-800 dark:text-slate-100">
            데이터베이스 설정 필요
          </h2>
          <p className="mt-1 max-w-xs text-xs text-slate-500 dark:text-slate-400">
            현재 화장실 데이터베이스 연결 설정이 완료되지 않았습니다.
          </p>
          <Link
            href="/map"
            className="mt-4 rounded-xl bg-blue-600 px-4 py-2.5 text-xs font-semibold text-white shadow"
          >
            ← 지도로 돌아가기
          </Link>
        </div>
      </AppShell>
    );
  }

  let restroom = null;
  let currentUser = null;
  let activeAccessDetail: CustomerAccessDetail | null = null;
  try {
    const supabase = await createServerClientInstance();
    restroom = await getPublicRestroomDetail(supabase, id);

    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      currentUser = {
        id: user.id,
        email: user.email,
        name:
          (user.user_metadata?.name as string) ||
          (user.user_metadata?.display_name as string) ||
          null,
      };
    }
  } catch (error) {
    console.error(`[RestroomDetailPage] Failed to fetch restroom ${id}:`, error);
  }

  // E2E Mock 환경 대비 (ALLOW_E2E_MOCK=1)
  if (isE2eMockEnabled) {
    if (!currentUser) {
      try {
        const cookieStore = await cookies();
        if (isE2eMockSessionAllowed(cookieStore.get("e2e_mock_customer")?.value)) {
          currentUser = {
            id: "ff5e3efe-07bf-4f54-b60e-d9f5086ca231",
            email: "mock-customer@hujimap.com",
            name: "테스트고객",
          };
        }
      } catch {}
    }

    if (!restroom) {
      if (id === "b2222222-2222-4222-8222-222222222222") {
        restroom = {
          id: "b2222222-2222-4222-8222-222222222222",
          type: "partner",
          name: "행궁 안심제휴 카페 화장실",
          road_address: "수원시 팔달구 화서문로 42",
          address_detail: "1층",
          latitude: 37.2845,
          longitude: 127.0155,
          access_method: "pin",
          gender_type: "separate",
          wheelchair_accessible: true,
          baby_changing_available: true,
          sanitary_products_available: false,
          last_verified_at: "2026-11-10T10:00:00Z",
          business_id: "c3333333-3333-4333-8333-333333333333",
          business: {
            id: "c3333333-3333-4333-8333-333333333333",
            name: "행궁 안심카페 본점",
            category: "카페/디저트",
            road_address: "수원시 팔달구 화서문로 42",
            phone: "031-123-4567",
          },
          description: "행궁동 카페 제휴 화장실 상세 정보",
          entrance_instructions: "카운터 우측 계단 반층 위",
          hours: [{ id: "h1", restroom_id: id, weekday: 1, opens_at: "09:00", closes_at: "22:00", is_closed: false }],
          active_policy: {
            id: "mock-policy-1",
            version: 1,
            access_mode: "test_deposit",
            deposit_amount_krw: 1000,
            refund_eligible: true,
            receipt_window_hours: 24,
            min_purchase_krw: 0,
            effective_from: "2026-11-10T10:00:00Z",
          },
          photos: [],
        } as any;
      } else if (id === "a1111111-1111-4111-8111-111111111111") {
        restroom = {
          id: "a1111111-1111-4111-8111-111111111111",
          type: "public",
          name: "수원화성 장안문 공중화장실",
          road_address: "수원시 팔달구 정조로 910",
          latitude: 37.2885,
          longitude: 127.0142,
          access_method: "open",
          gender_type: "separate",
          wheelchair_accessible: true,
          baby_changing_available: false,
          sanitary_products_available: false,
          last_verified_at: "2026-11-10T10:00:00Z",
          description: "장안문 인근 무료 공공 화장실",
          hours: [],
          photos: [],
        } as any;
      }
    }
  }

  if (!restroom) {
    return (
      <AppShell headerTitle="화장실 상세">
        <div className="flex flex-1 flex-col items-center justify-center p-6 text-center">
          <div className="mb-3 text-4xl">🚹</div>
          <h2 className="text-base font-bold text-slate-800 dark:text-slate-100">
            화장실을 찾을 수 없습니다
          </h2>
          <p className="mt-1 max-w-xs text-xs text-slate-500 dark:text-slate-400">
            해당 화장실이 존재하지 않거나 현재 비공개(미승인/임시 중단)
            상태입니다.
          </p>
          <Link
            href="/map"
            className="mt-4 rounded-xl bg-blue-600 px-4 py-2.5 text-xs font-semibold text-white shadow"
          >
            ← 지도로 돌아가기
          </Link>
        </div>
      </AppShell>
    );
  }

  if (currentUser && restroom?.type === "partner") {
    try {
      activeAccessDetail = await getLatestActiveCustomerAccessForRestroom({
        userId: currentUser.id,
        restroomId: id,
      });
    } catch {
      activeAccessDetail = null;
    }
  }

  return (
    <AppShell headerTitle={restroom.name}>
      <RestroomDetailClient
        restroom={restroom}
        currentUser={currentUser}
        initialActiveAccess={activeAccessDetail}
      />
    </AppShell>
  );
}

