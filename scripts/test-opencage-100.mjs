#!/usr/bin/env node
/**
 * OpenCage Geocoding API 100-record Free Trial Verification Script
 * - Strictly separate from Kakao geocoding cache and coordinates.
 * - Never writes to local or remote Supabase databases.
 * - Defaults to --dry-run; actual API calls require --live --confirm and OPENCAGE_API_KEY.
 */

import fs from "node:fs";
import path from "node:path";
import {
  OPENCAGE_DEFAULT_MIN_DELAY_MS,
  OPENCAGE_DEFAULT_SAMPLE_SIZE,
  OPENCAGE_FREE_TRIAL_DAILY_LIMIT,
  decodePublicCsvBuffer,
  parsePublicCsvRows,
  selectOpenCageSample,
  runOpenCageTrial,
} from "../src/lib/imports/opencage.ts";

// Load .env.local without logging secret values
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

function getArgValue(args, flag) {
  const idx = args.indexOf(flag);
  if (idx === -1 || !args[idx + 1] || args[idx + 1].startsWith("--")) {
    return null;
  }
  return args[idx + 1];
}

function parsePositiveInt(args, flag, fallback) {
  const raw = getArgValue(args, flag);
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`오류: ${flag} 값은 1 이상의 정수여야 합니다.`);
    process.exit(1);
  }
  return n;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(`
사용법: node scripts/test-opencage-100.mjs [옵션]

옵션:
  --file <경로>       원본 CSV 경로 (기본값: local-data/public_restroom_raw.csv)
  --scope <범위>      표본 대상 (gyeonggi | all, 기본값: gyeonggi)
  --limit <건수>      시험 건수 (기본값/최대: ${OPENCAGE_DEFAULT_SAMPLE_SIZE})
  --min-delay-ms <ms> 요청 간격 ms (기본값/최소: ${OPENCAGE_DEFAULT_MIN_DELAY_MS})
  --out <경로>        결과 JSON 저장 경로 (기본값: local-data/opencage_trial_100.json)
  --dry-run           HTTP 호출 없이 표본/쿼리 사전 점검만 실행 (기본값)
  --live              실제 OpenCage API 호출 모드 진입
  --confirm           --live 호출 최종 승인 플래그 (사용자 승인 후 지정)
`);
    process.exit(0);
  }

  const fileArg = getArgValue(args, "--file") || "local-data/public_restroom_raw.csv";
  const filePath = path.resolve(process.cwd(), fileArg);
  if (!fs.existsSync(filePath)) {
    console.error(`오류: CSV 파일을 찾을 수 없습니다: ${filePath}`);
    process.exit(1);
  }

  const scopeRaw = getArgValue(args, "--scope") || "gyeonggi";
  const scope = scopeRaw === "all" ? "all" : "gyeonggi";
  const limit = Math.min(
    OPENCAGE_DEFAULT_SAMPLE_SIZE,
    parsePositiveInt(args, "--limit", OPENCAGE_DEFAULT_SAMPLE_SIZE)
  );
  const minDelayMs = Math.max(
    OPENCAGE_DEFAULT_MIN_DELAY_MS,
    parsePositiveInt(args, "--min-delay-ms", OPENCAGE_DEFAULT_MIN_DELAY_MS)
  );
  const outPath = getArgValue(args, "--out") || "local-data/opencage_trial_100.json";
  const isLive = args.includes("--live");
  const isConfirmed = args.includes("--confirm");
  const isDryRun = !isLive || args.includes("--dry-run");

  const csvText = decodePublicCsvBuffer(fs.readFileSync(filePath));
  const rows = parsePublicCsvRows(csvText);
  const samples = selectOpenCageSample(rows, { scope, limit });
  const hasApiKey = Boolean((process.env.OPENCAGE_API_KEY || "").trim());

  console.log("=== OpenCage 100건 무료 시험 준비/검증 ===");
  console.log(`CSV 경로: ${filePath}`);
  console.log(`대상 범위: ${scope} (전체 ${rows.length.toLocaleString()}건 중 ${samples.length}건 균등 추출)`);
  console.log(`요청 간격: ${minDelayMs}ms (Free Trial 제한: 1 req/sec, 일일 ${OPENCAGE_FREE_TRIAL_DAILY_LIMIT.toLocaleString()}건)`);
  console.log(`OPENCAGE_API_KEY 상태: ${hasApiKey ? "설정됨(값 비공개)" : "미설정(설정 필요)"}`);
  console.log(`실행 모드: ${isDryRun ? "DRY-RUN (외부 API 미호출)" : "LIVE (실제 OpenCage API 호출)"}`);

  const nonEmptyQueries = samples.filter((s) => Boolean(s.queryAddress)).length;
  console.log(`유효 주소 쿼리: ${nonEmptyQueries}/${samples.length}건`);
  if (samples.length > 0) {
    console.log("샘플 쿼리 3건:");
    for (const s of samples.slice(0, 3)) {
      console.log(`  #${s.sampleIndex} [${s.city || "-"}] ${s.name} => "${s.queryAddress}"`);
    }
  }

  if (isDryRun) {
    console.log("\n[안내] DRY-RUN 완료: 실제 OpenCage API 호출 및 DB 변경을 수행하지 않았습니다.");
    process.exit(0);
  }

  const result = await runOpenCageTrial(samples, {
    apiKey: process.env.OPENCAGE_API_KEY,
    dryRun: false,
    confirmed: isConfirmed,
    scope,
    limit,
    minDelayMs,
    outPath,
  });

  if (result.blockedReason) {
    console.warn(`\n[중단] ${result.blockedReason}`);
    process.exit(hasApiKey ? 0 : 1);
  }

  console.log("\n=== OpenCage 실호출 결과 요약 ===");
  console.log(JSON.stringify(result.summary, null, 2));
  console.log(`결과 저장: ${path.resolve(process.cwd(), outPath)}`);
}

main().catch((err) => {
  console.error("OpenCage 시험 실행 중 오류:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
