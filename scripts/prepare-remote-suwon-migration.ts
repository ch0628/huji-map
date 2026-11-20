#!/usr/bin/env node
/**
 * STEP 3 — Remote Supabase Migration & Selective Load Runner
 *
 * Strictly loads ONLY verified Gyeonggi public-data Suwon restrooms
 * (`type = 'public'`, `publication_status = 'published'`, `coordinate_source = 'gg_publtolt_15011425'`).
 * Never touches or includes QA accounts, partner restrooms, drafts, or Kakao-derived coords.
 *
 * Defaults to --dry-run. Actual remote write requires explicit --live --confirm
 * AND REMOTE_SUPABASE_URL + REMOTE_SUPABASE_SECRET_KEY environment variables.
 */

import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { isValidKoreaWgs84 } from "../src/lib/imports";

export interface RemoteExportPackage {
  exportedAt: string;
  sourceFilter: string;
  counts: {
    publicDataSources: number;
    restrooms: number;
    activePolicies: number;
  };
  publicDataSources: Array<Record<string, any>>;
  restrooms: Array<Record<string, any>>;
  restroomAccessPolicies: Array<Record<string, any>>;
}

export function validateRemoteExportPackage(pkg: RemoteExportPackage): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  if (!Array.isArray(pkg.publicDataSources) || pkg.publicDataSources.length === 0) {
    errors.push("publicDataSources가 비어 있습니다.");
  }
  if (!Array.isArray(pkg.restrooms) || pkg.restrooms.length === 0) {
    errors.push("restrooms 이전 대상이 비어 있습니다.");
  }

  const sourceIds = new Set((pkg.publicDataSources || []).map((s) => s.id));
  const restroomIds = new Set<string>();

  for (const r of pkg.restrooms || []) {
    restroomIds.add(r.id);
    if (r.type !== "public") {
      errors.push(`비공공 화장실 혼입 차단: ${r.id} (type=${r.type})`);
    }
    if (r.publication_status !== "published") {
      errors.push(
        `비공개/초안 화장실 혼입 차단: ${r.id} (status=${r.publication_status})`
      );
    }
    if (r.coordinate_source !== "gg_publtolt_15011425") {
      errors.push(
        `미허용 좌표 출처 혼입 차단: ${r.id} (coordinate_source=${r.coordinate_source})`
      );
    }
    if (r.business_id !== null && r.business_id !== undefined) {
      errors.push(`제휴 business_id 혼입 차단: ${r.id}`);
    }
    if (r.created_by !== null || r.approved_by !== null) {
      errors.push(`로컬 QA created_by/approved_by 혼입 차단: ${r.id}`);
    }
    if (!sourceIds.has(r.source_id) || !sourceIds.has(r.coordinate_source_id)) {
      errors.push(`누락된 public_data_sources 참조: ${r.id}`);
    }
    if (!r.coordinate_source_record_id) {
      errors.push(`누락된 원천 좌표 식별자: ${r.id}`);
    }
    if (!isValidKoreaWgs84(Number(r.latitude), Number(r.longitude))) {
      errors.push(`유효하지 않은 좌표: ${r.id} (${r.latitude}, ${r.longitude})`);
    }
    if (
      /demo\/test|qa\b/i.test(String(r.name || "")) ||
      /demo\/test/i.test(String(r.road_address || ""))
    ) {
      errors.push(`QA/DEMO 데이터 혼입 차단: ${r.id} (${r.name})`);
    }
  }

  const policyMap = new Map<string, number>();
  for (const p of pkg.restroomAccessPolicies || []) {
    if (!restroomIds.has(p.restroom_id)) {
      errors.push(`대상 외 화장실 정책 혼입 차단: ${p.restroom_id}`);
    }
    if (p.access_mode !== "free" || Number(p.deposit_amount_krw) !== 0 || p.refund_eligible !== false || p.is_active !== true) {
      errors.push(`공공화장실 무료 정책 위반: ${p.restroom_id}`);
    }
    policyMap.set(p.restroom_id, (policyMap.get(p.restroom_id) ?? 0) + 1);
  }

  for (const r of pkg.restrooms || []) {
    if (policyMap.get(r.id) !== 1) {
      errors.push(`화장실당 활성 무료 정책 1건 누락/중복: ${r.id}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

function getArgValue(args: string[], flag: string): string | null {
  const idx = args.indexOf(flag);
  if (idx === -1 || !args[idx + 1] || args[idx + 1].startsWith("--")) {
    return null;
  }
  return args[idx + 1];
}

function parsePositiveInt(
  args: string[],
  flag: string,
  fallback: number | null
): number | null {
  const raw = getArgValue(args, flag);
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`오류: ${flag}는 1 이상의 정수여야 합니다.`);
    process.exit(1);
  }
  return n;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(`
사용법: npx tsx scripts/prepare-remote-suwon-migration.ts [옵션]

옵션:
  --in <경로>          선별 export JSON 경로 (기본값: local-data/suwon_remote_export.json)
  --sample <건수>      소량 시험 적재 건수 (예: 50)
  --batch-size <건수>  배치 크기 (기본값: 250)
  --dry-run            원격 DB 쓰기 없이 패키지 검증만 수행 (기본값)
  --live               원격 Supabase DB 적재 (REMOTE_SUPABASE_URL, REMOTE_SUPABASE_SECRET_KEY 필수)
  --confirm            --live 최종 실행 승인 플래그
`);
    process.exit(0);
  }

  const inPath = path.resolve(
    process.cwd(),
    getArgValue(args, "--in") || "local-data/suwon_remote_export.json"
  );
  if (!fs.existsSync(inPath)) {
    console.error(`오류: export 파일을 찾을 수 없습니다: ${inPath}`);
    process.exit(1);
  }

  const pkg = JSON.parse(fs.readFileSync(inPath, "utf8")) as RemoteExportPackage;
  const validation = validateRemoteExportPackage(pkg);
  if (!validation.valid) {
    console.error("패키지 무결성 검증 실패:");
    for (const err of validation.errors.slice(0, 20)) {
      console.error(`  - ${err}`);
    }
    process.exit(1);
  }

  const sampleLimit = parsePositiveInt(args, "--sample", null);
  const batchSize = parsePositiveInt(args, "--batch-size", 250) ?? 250;
  const targetRestrooms =
    sampleLimit !== null
      ? pkg.restrooms.slice(0, sampleLimit)
      : pkg.restrooms;
  const targetIds = new Set(targetRestrooms.map((r) => r.id));
  const targetPolicies = pkg.restroomAccessPolicies.filter((p) =>
    targetIds.has(p.restroom_id)
  );

  const isLive = args.includes("--live");
  const isConfirmed = args.includes("--confirm");
  const isDryRun = !isLive || args.includes("--dry-run");

  console.log("=== STEP 3 원격 Supabase 이전 검증/적재 ===");
  console.log(`입력 패키지: ${inPath}`);
  console.log(
    `검증 결과: PASS (출처 ${pkg.publicDataSources.length}건, 전체 선별 화장실 ${pkg.restrooms.length}건, 무료 정책 ${pkg.restroomAccessPolicies.length}건)`
  );
  console.log(
    `이번 적재 대상: 화장실 ${targetRestrooms.length}건, 정책 ${targetPolicies.length}건 (배치 크기: ${batchSize})`
  );
  console.log("혼입 검증: QA 계정(0), 제휴 화장실(0), draft(0), kakao_geocode(0)");
  console.log(
    `실행 모드: ${isDryRun ? "DRY-RUN (원격 DB 미변경)" : "LIVE (원격 DB 적재)"}`
  );

  if (isDryRun || !isConfirmed) {
    console.log(
      "\n[안내] 원격 DB는 변경되지 않았습니다. 승인 후 백업·마이그레이션 적용 뒤 --live --confirm 으로 실행하세요."
    );
    return;
  }

  const remoteUrl = (process.env.REMOTE_SUPABASE_URL || "").trim();
  const remoteKey = (process.env.REMOTE_SUPABASE_SECRET_KEY || "").trim();
  if (!remoteUrl || !remoteKey) {
    console.error(
      "오류: 원격 적재 시 REMOTE_SUPABASE_URL 및 REMOTE_SUPABASE_SECRET_KEY 환경변수가 필요합니다."
    );
    process.exit(1);
  }
  const parsedUrl = new URL(remoteUrl);
  if (
    parsedUrl.hostname === "127.0.0.1" ||
    parsedUrl.hostname === "localhost"
  ) {
    console.error(
      "오류: REMOTE_SUPABASE_URL에 로컬 호스트가 지정되었습니다. 원격 프로젝트 URL을 확인하세요."
    );
    process.exit(1);
  }

  const remoteSupabase = createClient(remoteUrl, remoteKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 1) Upsert public_data_sources
  const { error: srcUpdErr } = await remoteSupabase
    .from("public_data_sources")
    .upsert(pkg.publicDataSources, { onConflict: "id" });
  if (srcUpdErr) {
    throw new Error(`원격 public_data_sources 적재 실패: ${srcUpdErr.message}`);
  }

  // 2) Upsert restrooms in batches
  for (let i = 0; i < targetRestrooms.length; i += batchSize) {
    const chunk = targetRestrooms.slice(i, i + batchSize);
    const { error: restErr } = await remoteSupabase
      .from("restrooms")
      .upsert(chunk, { onConflict: "id" });
    if (restErr) {
      throw new Error(
        `원격 restrooms 배치 적재 실패 (offset=${i}): ${restErr.message}`
      );
    }
    console.log(
      `  restrooms 배치 완료: ${Math.min(i + chunk.length, targetRestrooms.length)}/${targetRestrooms.length}`
    );
  }

  // 3) Upsert active free policies in batches
  for (let i = 0; i < targetPolicies.length; i += batchSize) {
    const chunk = targetPolicies.slice(i, i + batchSize);
    const { error: polErr } = await remoteSupabase
      .from("restroom_access_policies")
      .upsert(chunk, { onConflict: "id" });
    if (polErr) {
      throw new Error(
        `원격 restroom_access_policies 배치 적재 실패 (offset=${i}): ${polErr.message}`
      );
    }
    console.log(
      `  policies 배치 완료: ${Math.min(i + chunk.length, targetPolicies.length)}/${targetPolicies.length}`
    );
  }

  console.log("\n원격 적재 완료. 원격 DB에서 ANALYZE 및 주변 400m RPC 검증을 실행하세요.");
}

const isEntry =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(import.meta.url.replace("file:///", "").replace(/\//g, path.sep));
if (isEntry || process.argv[1]?.endsWith("prepare-remote-suwon-migration.ts")) {
  main().catch((err) => {
    console.error("실행 오류:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
