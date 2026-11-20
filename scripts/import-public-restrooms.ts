#!/usr/bin/env node
/**
 * CLI Runner for Importing Public Restroom Data
 * Usage:
 *   npx tsx scripts/import-public-restrooms.ts --file tests/fixtures/public/suwon_public_restrooms_sample.csv --dry-run
 *   npx tsx scripts/import-public-restrooms.ts --file local-data/public_restroom_raw.csv --all-cities --geocode --max-calls 500 --dry-run
 *   npx tsx scripts/import-public-restrooms.ts --file local-data/public_restroom_raw.csv --all-cities --geocode --live --confirm
 *   npx tsx scripts/import-public-restrooms.ts --file local-data/public_restroom_raw.csv --all-cities --geocode --resume --live --confirm
 */

import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import {
  importPublicRestrooms,
  decodeCsvBuffer,
  createKakaoAddressGeocoder,
  DEFAULT_SUWON_SOURCE_CONFIG,
  DEFAULT_DAILY_GEOCODE_LIMIT,
  DEFAULT_MIN_DELAY_MS,
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

function getArgValue(args: string[], flag: string): string | null {
  const idx = args.indexOf(flag);
  if (idx === -1 || !args[idx + 1] || args[idx + 1].startsWith("--")) {
    return null;
  }
  return args[idx + 1];
}

function parsePositiveIntArg(
  args: string[],
  flag: string,
  fallback: number
): number {
  const raw = getArgValue(args, flag);
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`오류: ${flag} 옵션은 1 이상의 정수여야 합니다 (입력값: ${raw}).`);
    process.exit(1);
  }
  return n;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.length === 0) {
    console.log(`
사용법: npx tsx scripts/import-public-restrooms.ts [옵션]

옵션:
  --file <경로>             임포트할 공공화장실 CSV 파일 경로 (필수)
  --encoding <형식>         CSV 인코딩 (auto | utf8 | cp949, 기본값: auto)
  --city <도시명>           지역 필터링 (기본값: 수원, 전국 데이터셋 입력 시 타 지역 스킵)
  --all-cities              지역 필터링 해제 (전국 53,584건 수집 시 지정)
  --geocode                 위도/경도가 없는 레코드를 카카오 주소 검색 API로 변환
  --geocode-cache <경로>    지오코딩 캐시 JSON 경로 (기본값: local-data/kakao_geocode_cache.json)
  --usage-file <경로>       일일 카카오 API 호출량 JSON 경로 (기본값: local-data/kakao_geocode_usage.json)
  --daily-limit <건수>      금일 카카오 API 최대 호출 상한 (기본값: ${DEFAULT_DAILY_GEOCODE_LIMIT})
  --max-calls <건수>        이번 실행에서 허용할 최대 카카오 API HTTP 호출 수 (선택)
  --min-delay-ms <ms>       카카오 API 요청 간 최소 간격 ms (기본값: ${DEFAULT_MIN_DELAY_MS})
  --concurrency <수>        지오코딩 동시 처리 수 (기본값: 1)
  --batch-size <건수>       DB 분할 저장 및 체크포인트 단위 (기본값: 500)
  --checkpoint <경로>       중단/이어하기 체크포인트 파일 (기본값: local-data/import_checkpoint.json)
  --resume                  체크포인트 지점부터 이어서 실행
  --include-unlocated       좌표 미변환 신규 건도 draft로 저장 (기본값: 미변환 신규 건 저장 안 함)
  --regeocode               기존 DB 좌표가 있는 건도 강제로 재변환
  --dry-run                 DB 쓰기 없이 파싱·유효성·지오코딩 미리보기 (기본값)
  --live                    실제 DB 반영 모드 진입
  --confirm                 --live 모드에서 실제 DB 쓰기 최종 승인 플래그
  --help                    도움말 출력
`);
    process.exit(0);
  }

  const fileArg = getArgValue(args, "--file");
  if (!fileArg) {
    console.error("오류: --file <경로> 파라미터가 필요합니다.");
    process.exit(1);
  }

  const filePath = path.resolve(process.cwd(), fileArg);
  if (!fs.existsSync(filePath)) {
    console.error(`오류: 파일을 찾을 수 없습니다: ${filePath}`);
    process.exit(1);
  }

  const cityArg = getArgValue(args, "--city");
  const cityFilter = args.includes("--all-cities") ? null : cityArg || "수원";

  const rawEncoding = getArgValue(args, "--encoding") || "auto";
  const encoding: CsvEncoding =
    rawEncoding === "utf8" || rawEncoding === "cp949" ? rawEncoding : "auto";

  const enableGeocode = args.includes("--geocode");
  const geocodeCachePath =
    getArgValue(args, "--geocode-cache") ??
    (enableGeocode ? "local-data/kakao_geocode_cache.json" : null);
  const usageFilePath =
    getArgValue(args, "--usage-file") ??
    (enableGeocode ? "local-data/kakao_geocode_usage.json" : null);

  const dailyLimit = parsePositiveIntArg(
    args,
    "--daily-limit",
    DEFAULT_DAILY_GEOCODE_LIMIT
  );
  const maxCallsRaw = getArgValue(args, "--max-calls");
  const maxCallsPerRun = maxCallsRaw
    ? parsePositiveIntArg(args, "--max-calls", 0)
    : undefined;
  const minDelayMs = parsePositiveIntArg(
    args,
    "--min-delay-ms",
    DEFAULT_MIN_DELAY_MS
  );
  const geocodeConcurrency = parsePositiveIntArg(args, "--concurrency", 1);
  const batchSize = parsePositiveIntArg(args, "--batch-size", 500);

  const resume = args.includes("--resume");
  const isLive = args.includes("--live");
  const isConfirmed = args.includes("--confirm") || args.includes("--yes");
  const isDryRun = !isLive || args.includes("--dry-run");
  const skipUnlocatedNew = !args.includes("--include-unlocated");
  const regeocodeExisting = args.includes("--regeocode");

  const checkpointPath =
    getArgValue(args, "--checkpoint") ??
    (!isDryRun || resume ? "local-data/import_checkpoint.json" : null);

  console.log(`=== 공공화장실 데이터 수집기 ===`);
  console.log(`파일 경로: ${filePath}`);
  console.log(`인코딩 모드: ${encoding}`);
  console.log(
    `지역 필터: ${cityFilter ? `"${cityFilter}" 포함 레코드만 수집` : "전국 전체 레코드 수집"}`
  );
  console.log(
    `좌표 변환: ${enableGeocode ? `카카오 주소 검색 API (일일 상한 ${dailyLimit.toLocaleString()}건, 동시성 ${geocodeConcurrency}, 간격 ${minDelayMs}ms${maxCallsPerRun ? `, 이번 실행 최대 ${maxCallsPerRun.toLocaleString()}건` : ""})` : "CSV 내장 좌표만 사용"}`
  );
  console.log(
    `배치/보존: 배치 ${batchSize}건 | 미변환 신규 건 ${skipUnlocatedNew ? "저장 안 함(기존 좌표·상태만 보존)" : "draft 격리 저장"}`
  );
  if (checkpointPath) {
    console.log(
      `체크포인트: ${checkpointPath} (${resume ? "이어하기 --resume" : "새 실행/덮어쓰기"})`
    );
  }
  console.log(`실행 모드: ${isDryRun ? "DRY-RUN (미리보기/검증)" : "LIVE (실제 DB 쓰기)"}`);

  const rawBuffer = fs.readFileSync(filePath);
  const csvContent = decodeCsvBuffer(rawBuffer, encoding);

  const mockClient = {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
    }),
  } as any;

  // Fast parse-only preflight (never calls Kakao API before DB/checkpoint loop in --live mode)
  const parsePreflight = await importPublicRestrooms(mockClient, csvContent, {
    dryRun: true,
    cityFilter,
    skipUnlocatedNew,
    batchSize,
  });

  console.log("\n[CSV 파싱 사전 분석]");
  console.log(`- 전체 원천 레코드: ${parsePreflight.fetchedCount.toLocaleString()}건`);
  console.log(`- 대상 지역 유효 레코드: ${(parsePreflight.totalValidRecords ?? 0).toLocaleString()}건`);
  console.log(`- 타 지역 필터 스킵: ${parsePreflight.skippedCount.toLocaleString()}건`);
  console.log(`- 중복 식별자 건수: ${(parsePreflight.duplicateCount ?? 0).toLocaleString()}건`);
  console.log(`- 파싱/형식 오류: ${parsePreflight.errorCount.toLocaleString()}건`);

  if (parsePreflight.errors.length > 0) {
    console.log("\n[오류 레코드 상세 (최대 5건)]:");
    parsePreflight.errors.slice(0, 5).forEach((e) => {
      console.log(` - ${e.recordId ? `[${e.recordId}] ` : ""}${e.reason}`);
    });
    if (parsePreflight.errors.length > 5) {
      console.log(`   ...외 ${parsePreflight.errors.length - 5}건 생략`);
    }
  }

  const abortController = new AbortController();
  let signalCount = 0;
  const handleSignal = () => {
    signalCount++;
    if (signalCount === 1) {
      console.warn(
        "\n[중단 요청] 현재 배치를 안전하게 마무리하고 캐시·사용량·체크포인트를 저장한 뒤 종료합니다..."
      );
      abortController.abort();
    } else {
      console.error("\n[강제 종료] 두 번째 중단 신호를 수신했습니다.");
      process.exit(130);
    }
  };
  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  const geocoder = enableGeocode
    ? createKakaoAddressGeocoder({
        cachePath: geocodeCachePath,
        usagePath: usageFilePath,
        dailyLimit,
        maxCallsPerRun,
        minDelayMs,
      })
    : undefined;

  try {
    if (isDryRun) {
      if (enableGeocode) {
        console.log("\n[DRY-RUN] 지오코딩 미리보기를 실행합니다...");
        const dryResult = await importPublicRestrooms(mockClient, csvContent, {
          dryRun: true,
          cityFilter,
          geocoder,
          geocodeConcurrency,
          batchSize,
          checkpointPath,
          resume,
          skipUnlocatedNew,
          signal: abortController.signal,
          onBatchProgress: (p) => {
            console.log(
              `  [배치 ${p.batchIndex}/${p.totalBatches}] 진행 ${p.processedRecords.toLocaleString()}/${p.totalValidRecords.toLocaleString()}건 | 지오코딩 성공 ${p.geocodeSuccessCount} / 실패 ${p.geocodeFailedCount} | HTTP 호출(이번/금일) ${p.runHttpCalls}/${p.todayHttpCalls}`
            );
          },
        });
        console.log("\n[DRY-RUN 지오코딩 요약]");
        console.log(`- 상태: ${dryResult.status}${dryResult.stoppedReason ? ` (${dryResult.stoppedReason})` : ""}`);
        console.log(`- 좌표 변환 성공: ${dryResult.geocodeSuccessCount ?? 0}건`);
        console.log(`- 좌표 변환 실패: ${dryResult.geocodeFailedCount ?? 0}건`);
        console.log(`- DB 적재 가능(좌표 확보): ${dryResult.insertedCount}건 / 미변환 스킵: ${dryResult.skippedUnlocatedNewCount ?? 0}건`);
        if (dryResult.geocodeStats) {
          console.log(
            `- 카카오 API 사용량: 이번 ${dryResult.geocodeStats.runHttpCalls}건 / 금일 누적 ${dryResult.geocodeStats.todayHttpCalls}건 / 일일 상한 ${dryResult.geocodeStats.dailyLimit}건 / 캐시 적중 ${dryResult.geocodeStats.cacheHits}건`
          );
        }
      }
      console.log("\n[안내] DRY-RUN 모드이므로 DB에 반영되지 않았습니다. 작업이 안전하게 완료되었습니다.");
      process.exit(0);
    }

    // LIVE mode requires explicit confirmation
    if (!isConfirmed) {
      console.warn("\n[안전 차단] --live 모드이지만 --confirm 플래그가 지정되지 않았습니다.");
      console.warn("실제 DB 쓰기를 실행하려면 --confirm 플래그를 함께 전달하세요.");
      process.exit(0);
    }

    // Live execution requires Supabase configuration
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey =
      process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

    if (!supabaseUrl || !serviceRoleKey) {
      console.error(
        "오류: 실제 DB 반영에는 NEXT_PUBLIC_SUPABASE_URL과 SUPABASE_SERVICE_ROLE_KEY(또는 SUPABASE_SECRET_KEY)가 필요합니다."
      );
      process.exit(1);
    }

    console.log(`\n대상 DB: ${supabaseUrl}`);
    console.log(
      `출처 정보(유지): ${DEFAULT_SUWON_SOURCE_CONFIG.providerName} / ${DEFAULT_SUWON_SOURCE_CONFIG.datasetName}`
    );
    console.log(`실제 DB 배치 반영을 시작합니다...`);

    const supabase = createClient(supabaseUrl, serviceRoleKey);
    const result = await importPublicRestrooms(supabase, csvContent, {
      dryRun: false,
      cityFilter,
      preserveAdminStatus: true,
      skipUnlocatedNew,
      regeocodeExisting,
      batchSize,
      checkpointPath,
      resume,
      geocoder,
      geocodeConcurrency,
      signal: abortController.signal,
      onBatchProgress: (p) => {
        console.log(
          `  [배치 ${p.batchIndex}/${p.totalBatches}] ${p.processedRecords.toLocaleString()}/${p.totalValidRecords.toLocaleString()}건 | 신규 ${p.insertedCount} / 갱신 ${p.updatedCount} / 스킵 ${p.skippedCount} / 미변환제외 ${p.skippedUnlocatedNewCount} | API(이번/금일) ${p.runHttpCalls}/${p.todayHttpCalls}`
        );
      },
    });

    console.log("\n=== LIVE 수집 결과 ===");
    console.log(`실행 상태: ${result.status}${result.stoppedReason ? ` (사유: ${result.stoppedReason})` : ""}`);
    console.log(`실행 ID: ${result.runId}`);
    console.log(`시작 위치 -> 다음 위치: ${(result.resumedFromIndex ?? 0).toLocaleString()} -> ${(result.nextIndex ?? 0).toLocaleString()} / ${(result.totalValidRecords ?? 0).toLocaleString()}건`);
    console.log(`신규 등록: ${result.insertedCount.toLocaleString()}건`);
    console.log(`정보 갱신: ${result.updatedCount.toLocaleString()}건`);
    console.log(`변경 없음(스킵): ${result.skippedCount.toLocaleString()}건`);
    console.log(`미변환 신규 제외: ${(result.skippedUnlocatedNewCount ?? 0).toLocaleString()}건`);
    console.log(`기존 DB 좌표 보존: ${(result.preservedExistingCount ?? 0).toLocaleString()}건`);
    console.log(`오류 건수: ${result.errorCount.toLocaleString()}건`);
    if (result.geocodeStats) {
      console.log(
        `카카오 API 사용량: 이번 ${result.geocodeStats.runHttpCalls.toLocaleString()}건 / 금일 누적 ${result.geocodeStats.todayHttpCalls.toLocaleString()}건 / 잔여 ${result.geocodeStats.remainingDailyQuota.toLocaleString()}건 / 캐시 적중 ${result.geocodeStats.cacheHits.toLocaleString()}건`
      );
    }

    if (result.status === "paused" && checkpointPath) {
      console.log("\n[안내] 작업이 안전하게 일시 정지되었습니다. 이어서 실행하려면 --resume 옵션을 추가하세요.");
    }

    if (result.errors.length > 0) {
      console.log("\n[오류 목록 (최대 10건)]:");
      result.errors.slice(0, 10).forEach((e) =>
        console.log(` - ${e.recordId ? `[${e.recordId}] ` : ""}${e.reason}`)
      );
    }

    if (result.status === "failed") {
      process.exit(1);
    }
  } finally {
    geocoder?.flushCache?.();
    geocoder?.flushUsage?.();
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
  }
}

main().catch((err) => {
  console.error("수집 실행 중 예외 발생:", err);
  process.exit(1);
});
