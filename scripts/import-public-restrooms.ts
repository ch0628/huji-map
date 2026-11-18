#!/usr/bin/env node
/**
 * CLI Runner for Importing Public Restroom Data
 * Usage:
 *   npx tsx scripts/import-public-restrooms.ts --file tests/fixtures/public/suwon_public_restrooms_sample.csv --dry-run
 *   npx tsx scripts/import-public-restrooms.ts --file <path> --live --confirm
 */

import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import {
  importPublicRestrooms,
  decodeCsvBuffer,
  createKakaoAddressGeocoder,
  DEFAULT_SUWON_SOURCE_CONFIG,
  type CsvEncoding,
} from "../src/lib/imports";

// Load .env.local if present
const envFile = path.resolve(process.cwd(), ".env.local");
if (fs.existsSync(envFile)) {
  const lines = fs.readFileSync(envFile, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const k = trimmed.slice(0, eqIdx).trim();
    const rawVal = trimmed.slice(eqIdx + 1).trim();
    const unquoted = rawVal.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    if (k && !process.env[k]) {
      process.env[k] = unquoted;
    }
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.length === 0) {
    console.log(`
사용법: npx tsx scripts/import-public-restrooms.ts [옵션]

옵션:
  --file <경로>           임포트할 공공화장실 CSV 파일 경로 (필수)
  --encoding <형식>       CSV 인코딩 (auto | utf8 | cp949, 기본값: auto)
  --geocode               위도/경도가 없는 레코드를 카카오 주소 검색 API로 변환
  --geocode-cache <경로>  지오코딩 결과 캐시 JSON 경로 (선택)
  --dry-run               DB 쓰기 없이 파싱 및 유효성 검증만 수행 (기본값)
  --live                  실제 DB에 반영 모드 진입
  --confirm               --live 모드에서 실제 DB 쓰기 최종 승인 플래그
  --city <도시명>         지역 필터링 (기본값: 수원, 전국 데이터셋 입력 시 타 지역 스킵)
  --all-cities            지역 필터링 해제
  --help                  도움말 출력
`);
    process.exit(0);
  }

  const fileIdx = args.indexOf("--file");
  if (fileIdx === -1 || !args[fileIdx + 1]) {
    console.error("오류: --file <경로> 파라미터가 필요합니다.");
    process.exit(1);
  }

  const filePath = path.resolve(process.cwd(), args[fileIdx + 1]);
  if (!fs.existsSync(filePath)) {
    console.error(`오류: 파일을 찾을 수 없습니다: ${filePath}`);
    process.exit(1);
  }

  const cityIdx = args.indexOf("--city");
  const cityFilter = args.includes("--all-cities")
    ? null
    : cityIdx !== -1 && args[cityIdx + 1]
    ? args[cityIdx + 1]
    : "수원";

  const encodingIdx = args.indexOf("--encoding");
  const rawEncoding = encodingIdx !== -1 ? args[encodingIdx + 1] : "auto";
  const encoding: CsvEncoding =
    rawEncoding === "utf8" || rawEncoding === "cp949" ? rawEncoding : "auto";

  const enableGeocode = args.includes("--geocode");
  const cacheIdx = args.indexOf("--geocode-cache");
  const geocodeCachePath =
    cacheIdx !== -1 && args[cacheIdx + 1] ? args[cacheIdx + 1] : null;

  const isLive = args.includes("--live");
  const isConfirmed = args.includes("--confirm") || args.includes("--yes");
  const isDryRun = !isLive || args.includes("--dry-run");

  console.log(`=== 공공화장실 데이터 수집기 ===`);
  console.log(`파일 경로: ${filePath}`);
  console.log(`인코딩 모드: ${encoding}`);
  console.log(`지역 필터: ${cityFilter ? `"${cityFilter}" 포함 레코드만 수집` : "전체 레코드 수집"}`);
  console.log(`좌표 변환: ${enableGeocode ? "카카오 주소 검색 API 활성화" : "CSV 내장 좌표만 사용"}`);
  console.log(`실행 모드: ${isDryRun ? "DRY-RUN (미리보기/검증)" : "LIVE (실제 DB 쓰기)"}`);

  const rawBuffer = fs.readFileSync(filePath);
  const csvContent = decodeCsvBuffer(rawBuffer, encoding);

  const geocoder = enableGeocode
    ? createKakaoAddressGeocoder({ cachePath: geocodeCachePath })
    : undefined;

  // Always run dry-run inspection first
  const mockClient = {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
    }),
  } as any;

  const preflight = await importPublicRestrooms(mockClient, csvContent, {
    dryRun: true,
    cityFilter,
    geocoder,
  });

  if (geocoder) {
    geocoder.flushCache();
  }

  console.log("\n[사전 분석 결과 요약]");
  console.log(`- 전체 원천 레코드: ${preflight.fetchedCount}건`);
  console.log(`- 대상 지역 레코드: ${preflight.cityMatchedCount ?? preflight.insertedCount}건`);
  console.log(`- 타 지역 필터 스킵: ${preflight.skippedCount}건`);
  console.log(`- 중복 식별자 건수: ${preflight.duplicateCount ?? 0}건`);
  console.log(`- 파싱/형식 오류: ${preflight.errorCount}건`);
  if (enableGeocode) {
    console.log(`- 좌표 변환 성공: ${preflight.geocodeSuccessCount ?? 0}건`);
    console.log(`- 좌표 변환 실패/격리: ${preflight.geocodeFailedCount ?? 0}건`);
  }
  console.log(`- 최종 DB 적재 가능 건수: ${preflight.insertedCount}건 (지도 공개 가능 published: ${preflight.publishedCount ?? 0}건 / 위치 불명 격리 draft: ${preflight.draftCount ?? 0}건)`);

  if (preflight.errors.length > 0) {
    console.log("\n[오류 레코드 상세 (최대 5건)]:");
    preflight.errors.slice(0, 5).forEach((e) => {
      console.log(` - ${e.recordId ? `[${e.recordId}] ` : ""}${e.reason}`);
    });
    if (preflight.errors.length > 5) {
      console.log(`   ...외 ${preflight.errors.length - 5}건 생략`);
    }
  }

  if (isDryRun) {
    console.log("\n[안내] DRY-RUN 모드이므로 DB에 반영되지 않았습니다. 작업이 안전하게 완료되었습니다.");
    process.exit(0);
  }

  // LIVE mode requires explicit confirmation
  if (!isConfirmed) {
    console.warn("\n[안전 차단] --live 모드이지만 --confirm 플래그가 지정되지 않았습니다.");
    console.warn("실제 DB 쓰기를 실행하려면 다음 명령어를 실행하세요:");
    console.warn(`  npx tsx scripts/import-public-restrooms.ts --file "${filePath}" --live --confirm\n`);
    process.exit(0);
  }

  // Live execution requires Supabase configuration
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    console.error("오류: 실제 DB 반영에는 NEXT_PUBLIC_SUPABASE_URL과 SUPABASE_SERVICE_ROLE_KEY(또는 SUPABASE_SECRET_KEY)가 필요합니다.");
    process.exit(1);
  }

  console.log(`\n대상 DB: ${supabaseUrl}`);
  console.log(`출처 정보: ${DEFAULT_SUWON_SOURCE_CONFIG.providerName} / ${DEFAULT_SUWON_SOURCE_CONFIG.datasetName}`);
  console.log(`실제 DB 반영을 시작합니다...`);

  const supabase = createClient(supabaseUrl, serviceRoleKey);
  const result = await importPublicRestrooms(supabase, csvContent, {
    dryRun: false,
    cityFilter,
    preserveAdminStatus: true,
    geocoder,
  });

  console.log("\n=== LIVE 수집 완료 결과 ===");
  console.log(`실행 상태: ${result.status}`);
  console.log(`실행 ID: ${result.runId}`);
  console.log(`전체 수집: ${result.fetchedCount}건`);
  console.log(`신규 등록: ${result.insertedCount}건`);
  console.log(`정보 갱신: ${result.updatedCount}건`);
  console.log(`변경 없음(스킵): ${result.skippedCount}건`);
  console.log(`오류 건수: ${result.errorCount}건`);

  if (result.errors.length > 0) {
    console.log("\n[오류 목록]:");
    result.errors.forEach((e) => console.log(` - ${e.recordId ? `[${e.recordId}] ` : ""}${e.reason}`));
  }
}

main().catch((err) => {
  console.error("수집 실행 중 예외 발생:", err);
  process.exit(1);
});
