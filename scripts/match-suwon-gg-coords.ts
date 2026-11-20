#!/usr/bin/env node
/**
 * STEP 3 — Match existing Suwon public restrooms against Gyeonggi Publtolt (15011425)
 * and apply verified coordinates + provenance to local Supabase DB.
 *
 * Usage:
 *   npx tsx scripts/match-suwon-gg-coords.ts --dry-run
 *   npx tsx scripts/match-suwon-gg-coords.ts --live --confirm
 */

import fs from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import {
  decodeCsvBuffer,
  parseCsv,
  parseGgCsvRecords,
  matchSuwonRestroomsWithGgData,
  GG_PUBL_SOURCE_CONFIG,
  type SuwonDbRestroomCandidate,
  type CsvEncoding,
} from "../src/lib/imports";

// Load .env.local without printing secret values
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

function assertLocalSupabaseUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`유효하지 않은 Supabase URL입니다: ${url}`);
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error(
      `안전 차단: 이 스크립트는 로컬 DB(127.0.0.1/localhost) 전용입니다. 원격 URL(${host})에는 실행할 수 없습니다.`
    );
  }
}

async function fetchAllSuwonPublicTargets(
  supabase: any
): Promise<Array<Record<string, any>>> {
  const rows: Array<Record<string, any>> = [];
  const PAGE_SIZE = 1000;
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from("restrooms")
      .select(
        "id, business_id, source_id, source_record_id, coordinate_source, coordinate_source_id, coordinate_source_record_id, type, name, description, road_address, address_detail, latitude, longitude, floor, entrance_instructions, gender_type, wheelchair_accessible, baby_changing_available, sanitary_products_available, access_method, publication_status, last_verified_at, created_at, updated_at"
      )
      .eq("type", "public")
      .or("road_address.ilike.%수원시%,address_detail.ilike.%수원시%")
      .order("source_record_id", { ascending: true })
      .order("id", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (error) {
      throw new Error(`로컬 DB 수원시 화장실 조회 실패: ${error.message}`);
    }
    if (!data || data.length === 0) break;
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return rows;
}

async function ensureGgPublicDataSource(supabase: any): Promise<string> {
  const { data: existing, error: findErr } = await supabase
    .from("public_data_sources")
    .select("id")
    .eq("source_url", GG_PUBL_SOURCE_CONFIG.sourceUrl)
    .maybeSingle();

  if (findErr) {
    throw new Error(`경기도 출처 조회 실패: ${findErr.message}`);
  }
  if (existing?.id) {
    return existing.id;
  }

  const { data: created, error: insertErr } = await supabase
    .from("public_data_sources")
    .insert({
      provider_name: GG_PUBL_SOURCE_CONFIG.providerName,
      dataset_name: GG_PUBL_SOURCE_CONFIG.datasetName,
      source_url: GG_PUBL_SOURCE_CONFIG.sourceUrl,
      api_endpoint: GG_PUBL_SOURCE_CONFIG.apiEndpoint ?? null,
      license_name: GG_PUBL_SOURCE_CONFIG.licenseName ?? null,
      license_url: GG_PUBL_SOURCE_CONFIG.licenseUrl ?? null,
      attribution_text: GG_PUBL_SOURCE_CONFIG.attributionText ?? null,
    })
    .select("id")
    .single();

  if (insertErr || !created?.id) {
    throw new Error(
      `경기도 출처 등록 실패: ${insertErr?.message ?? "unknown"}`
    );
  }
  return created.id;
}

async function ensureActiveFreePolicies(
  supabase: any,
  restroomIds: string[]
): Promise<number> {
  if (restroomIds.length === 0) return 0;

  const CHUNK_SIZE = 100;
  const hasAnyPolicy = new Set<string>();
  for (let i = 0; i < restroomIds.length; i += CHUNK_SIZE) {
    const chunk = restroomIds.slice(i, i + CHUNK_SIZE);
    const { data: existingPolicies, error: checkErr } = await supabase
      .from("restroom_access_policies")
      .select("restroom_id, is_active")
      .in("restroom_id", chunk);

    if (checkErr) {
      throw new Error(`무료 정책 조회 실패: ${checkErr.message}`);
    }
    for (const p of existingPolicies || []) {
      hasAnyPolicy.add(p.restroom_id);
    }
  }

  const missingIds = restroomIds.filter((id) => !hasAnyPolicy.has(id));
  if (missingIds.length === 0) return 0;

  const nowIso = new Date().toISOString();
  const inserts = missingIds.map((restroomId) => ({
    restroom_id: restroomId,
    version: 1,
    access_mode: "free",
    deposit_amount_krw: 0,
    refund_eligible: false,
    is_active: true,
    effective_from: nowIso,
  }));

  for (let i = 0; i < inserts.length; i += CHUNK_SIZE) {
    const chunk = inserts.slice(i, i + CHUNK_SIZE);
    const { error: insertErr } = await supabase
      .from("restroom_access_policies")
      .insert(chunk);

    if (insertErr) {
      throw new Error(`무료 정책 생성 실패: ${insertErr.message}`);
    }
  }
  return inserts.length;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(`
사용법: npx tsx scripts/match-suwon-gg-coords.ts [옵션]

옵션:
  --gg-csv <경로>       경기도 공중화장실 현황 CSV (기본값: local-data/공중화장실현황(제공표준).csv)
  --encoding <형식>     CSV 인코딩 (auto | utf8 | cp949, 기본값: auto)
  --report-out <경로>   매칭 리포트 JSON 경로 (기본값: local-data/suwon_gg_match_report.json)
  --export-out <경로>   원격 이전 대상 JSON 경로 (기본값: local-data/suwon_remote_export.json)
  --backup-out <경로>   로컬 사전 백업 JSON 경로 (기본값: local-data/suwon_pre_gg_backup.json)
  --dry-run             DB 수정 없이 매칭 분석만 수행 (기본값)
  --live                로컬 DB에 매칭 좌표·출처 반영
  --confirm             --live 실행 최종 확인 플래그
`);
    process.exit(0);
  }

  const ggCsvPath = path.resolve(
    process.cwd(),
    getArgValue(args, "--gg-csv") || "local-data/공중화장실현황(제공표준).csv"
  );
  const encoding = (getArgValue(args, "--encoding") || "auto") as CsvEncoding;
  const reportOut = path.resolve(
    process.cwd(),
    getArgValue(args, "--report-out") || "local-data/suwon_gg_match_report.json"
  );
  const exportOut = path.resolve(
    process.cwd(),
    getArgValue(args, "--export-out") || "local-data/suwon_remote_export.json"
  );
  const backupOut = path.resolve(
    process.cwd(),
    getArgValue(args, "--backup-out") || "local-data/suwon_pre_gg_backup.json"
  );

  const isLive = args.includes("--live");
  const isConfirmed = args.includes("--confirm");
  const isDryRun = !isLive || args.includes("--dry-run");

  if (!fs.existsSync(ggCsvPath)) {
    console.error(`오류: 경기도 CSV 파일을 찾을 수 없습니다: ${ggCsvPath}`);
    process.exit(1);
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
  const serviceKey =
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    "";

  if (!supabaseUrl || !serviceKey) {
    console.error(
      "오류: NEXT_PUBLIC_SUPABASE_URL 및 SUPABASE_SECRET_KEY(또는 SUPABASE_SERVICE_ROLE_KEY)가 필요합니다."
    );
    process.exit(1);
  }
  assertLocalSupabaseUrl(supabaseUrl);

  const supabase = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log("=== STEP 3 경기도 공공데이터(15011425/Publtolt) 수원시 좌표 매칭 ===");
  console.log(`CSV 경로: ${ggCsvPath}`);
  console.log(`대상 DB: ${supabaseUrl} (로컬 전용)`);
  console.log(`실행 모드: ${isDryRun ? "DRY-RUN (DB 변경 없음)" : "LIVE (로컬 DB 반영)"}`);

  const ggBuffer = fs.readFileSync(ggCsvPath);
  const ggText = decodeCsvBuffer(ggBuffer, encoding);
  const ggRawRecords = parseCsv(ggText);
  const ggRows = parseGgCsvRecords(ggRawRecords);
  console.log(`경기도 CSV 파싱 완료: ${ggRows.length.toLocaleString()}건`);

  const rawDbRows = await fetchAllSuwonPublicTargets(supabase);
  // Strip latitude/longitude BEFORE matching so Kakao coords cannot influence matching
  const dbTargets: SuwonDbRestroomCandidate[] = rawDbRows.map((r) => ({
    id: r.id,
    name: r.name,
    roadAddress: r.road_address,
    addressDetail: r.address_detail ?? null,
    sourceId: r.source_id ?? null,
    sourceRecordId: r.source_record_id ?? null,
    publicationStatus: r.publication_status,
    lastVerifiedAt: r.last_verified_at ?? null,
    coordinateSource: r.coordinate_source ?? null,
  }));

  const report = matchSuwonRestroomsWithGgData(dbTargets, ggRows);

  console.log("\n--- 매칭 요약 ---");
  console.log(`수원시 전체 대상 건수: ${report.totalTargets}`);
  console.log(
    `정확히 매칭된 건수: ${report.matchedCount} (기존 published ${report.matchedPublishedCount} + 기존 draft ${report.matchedDraftCount})`
  );
  console.log(`매칭됐으나 공공데이터 좌표 없는 건수: ${report.missingCoordsCount}`);
  console.log(`매칭이 모호한 건수(복수 후보 보류): ${report.ambiguousCount}`);
  console.log(`매칭 실패(미일치) 건수: ${report.unmatchedCount}`);
  console.log(`원격 이전 가능 건수: ${report.eligibleForRemoteCount}`);

  fs.mkdirSync(path.dirname(reportOut), { recursive: true });
  fs.writeFileSync(
    reportOut,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        ggCsvPath: path.relative(process.cwd(), ggCsvPath),
        ggTotalRows: ggRows.length,
        summary: {
          totalTargets: report.totalTargets,
          matchedCount: report.matchedCount,
          matchedPublishedCount: report.matchedPublishedCount,
          matchedDraftCount: report.matchedDraftCount,
          missingCoordsCount: report.missingCoordsCount,
          ambiguousCount: report.ambiguousCount,
          unmatchedCount: report.unmatchedCount,
          eligibleForRemoteCount: report.eligibleForRemoteCount,
        },
        missingCoordsItems: report.items.filter(
          (i) => i.status === "missing_coords"
        ),
        ambiguousItems: report.items.filter((i) => i.status === "ambiguous"),
        unmatchedItems: report.items.filter((i) => i.status === "unmatched"),
        matchedItemsCount: report.matchedCount,
      },
      null,
      2
    ),
    "utf8"
  );
  console.log(`매칭 리포트 저장: ${reportOut}`);

  if (isDryRun) {
    console.log(
      "\n[안내] DRY-RUN 완료: 로컬 DB를 수정하지 않았습니다. 실제 반영은 --live --confirm을 사용하세요."
    );
    return;
  }

  if (!isConfirmed) {
    console.log(
      "\n[안전 중단] --live 모드에서는 --confirm 플래그가 필요합니다. 로컬 DB에 쓰지 않고 종료합니다."
    );
    return;
  }

  // 1) Pre-update backup (preserve initial snapshot if already created)
  if (!fs.existsSync(backupOut)) {
    fs.mkdirSync(path.dirname(backupOut), { recursive: true });
    fs.writeFileSync(
      backupOut,
      JSON.stringify(
        {
          backedUpAt: new Date().toISOString(),
          supabaseUrl,
          rowCount: rawDbRows.length,
          rows: rawDbRows,
        },
        null,
        2
      ),
      "utf8"
    );
    console.log(`로컬 사전 백업 저장 완료 (${rawDbRows.length}건): ${backupOut}`);
  } else {
    console.log(`기존 로컬 사전 백업 유지: ${backupOut}`);
  }

  // 2) Ensure Gyeonggi public_data_sources record & create import run
  const ggSourceId = await ensureGgPublicDataSource(supabase);
  const startedAt = new Date().toISOString();
  const { data: runRow, error: runInsertErr } = await supabase
    .from("public_import_runs")
    .insert({
      source_id: ggSourceId,
      started_at: startedAt,
      status: "running",
      fetched_count: report.totalTargets,
    })
    .select("id")
    .single();

  if (runInsertErr || !runRow?.id) {
    throw new Error(
      `수집 이력(public_import_runs) 생성 실패: ${runInsertErr?.message ?? "unknown"}`
    );
  }

  const matchedItems = report.items.filter((i) => i.status === "matched");
  let updatedCount = 0;
  let publishedFromDraftCount = 0;

  try {
    const dbRowById = new Map(rawDbRows.map((r) => [r.id, r]));
    const nowIso = new Date().toISOString();

    for (const item of matchedItems) {
      const prev = dbRowById.get(item.restroomId);
      if (!prev) continue;

      // Preserve admin archived/suspended status; upgrade unlocated draft to published when coords verified
      const nextStatus =
        prev.publication_status === "archived" ||
        prev.publication_status === "suspended"
          ? prev.publication_status
          : "published";

      if (prev.publication_status === "draft" && nextStatus === "published") {
        publishedFromDraftCount += 1;
      }

      const { error: updErr } = await supabase
        .from("restrooms")
        .update({
          latitude: item.latitude,
          longitude: item.longitude,
          coordinate_source: "gg_publtolt_15011425",
          coordinate_source_id: ggSourceId,
          coordinate_source_record_id: item.coordinateSourceRecordId,
          publication_status: nextStatus,
        })
        .eq("id", item.restroomId);

      if (updErr) {
        throw new Error(
          `화장실 좌표 업데이트 실패 (${item.restroomId} / ${item.restroomName}): ${updErr.message}`
        );
      }
      updatedCount += 1;
    }

    const createdPolicies = await ensureActiveFreePolicies(
      supabase,
      matchedItems.map((m) => m.restroomId)
    );
    console.log(
      `로컬 DB 업데이트 완료: ${updatedCount}건 좌표·출처 반영 (draft->published ${publishedFromDraftCount}건, 신규 무료정책 ${createdPolicies}건)`
    );

    const finishedAt = new Date().toISOString();
    await supabase
      .from("public_import_runs")
      .update({
        finished_at: finishedAt,
        status: "success",
        fetched_count: report.totalTargets,
        inserted_count: 0,
        updated_count: updatedCount,
        error_count: 0,
      })
      .eq("id", runRow.id);

    await supabase
      .from("public_data_sources")
      .update({ last_synced_at: finishedAt })
      .eq("id", ggSourceId);
  } catch (err: any) {
    await supabase
      .from("public_import_runs")
      .update({
        finished_at: new Date().toISOString(),
        status: "failed",
        updated_count: updatedCount,
        error_count: 1,
        error_message: err?.message ?? String(err),
      })
      .eq("id", runRow.id);
    throw err;
  }

  // 3) Export ONLY verified GG-sourced published public restrooms for remote migration
  const { data: verifiedRestrooms, error: exportQueryErr } = await supabase
    .from("restrooms")
    .select(
      "id, business_id, source_id, source_record_id, coordinate_source, coordinate_source_id, coordinate_source_record_id, type, name, description, road_address, address_detail, latitude, longitude, floor, entrance_instructions, gender_type, wheelchair_accessible, baby_changing_available, sanitary_products_available, access_method, publication_status, last_verified_at"
    )
    .eq("type", "public")
    .eq("publication_status", "published")
    .eq("coordinate_source", "gg_publtolt_15011425")
    .not("latitude", "is", null)
    .not("longitude", "is", null)
    .order("source_record_id", { ascending: true });

  if (exportQueryErr) {
    throw new Error(`원격 이전 대상 조회 실패: ${exportQueryErr.message}`);
  }

  const exportRows = verifiedRestrooms || [];
  const sourceIds = Array.from(
    new Set(
      exportRows
        .flatMap((r: any) => [r.source_id, r.coordinate_source_id])
        .filter(Boolean)
    )
  );
  const { data: sourcesData, error: srcErr } = await supabase
    .from("public_data_sources")
    .select(
      "id, provider_name, dataset_name, source_url, api_endpoint, license_name, license_url, attribution_text, last_synced_at"
    )
    .in("id", sourceIds);

  if (srcErr) {
    throw new Error(`원격 이전 출처 조회 실패: ${srcErr.message}`);
  }

  const exportIds = exportRows.map((r: any) => r.id);
  const policyData: Array<Record<string, any>> = [];
  const POLICY_CHUNK = 100;
  for (let i = 0; i < exportIds.length; i += POLICY_CHUNK) {
    const chunk = exportIds.slice(i, i + POLICY_CHUNK);
    const { data: chunkPol, error: polErr } = await supabase
      .from("restroom_access_policies")
      .select(
        "id, restroom_id, version, access_mode, deposit_amount_krw, refund_eligible, receipt_window_hours, min_purchase_krw, is_active, effective_from"
      )
      .in("restroom_id", chunk)
      .eq("is_active", true);

    if (polErr) {
      throw new Error(`원격 이전 정책 조회 실패: ${polErr.message}`);
    }
    if (chunkPol) {
      policyData.push(...chunkPol);
    }
  }

  fs.mkdirSync(path.dirname(exportOut), { recursive: true });
  fs.writeFileSync(
    exportOut,
    JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        sourceFilter:
          "type = 'public' AND publication_status = 'published' AND coordinate_source = 'gg_publtolt_15011425'",
        counts: {
          publicDataSources: (sourcesData || []).length,
          restrooms: exportRows.length,
          activePolicies: (policyData || []).length,
        },
        publicDataSources: sourcesData || [],
        restrooms: exportRows.map((r: any) => ({
          ...r,
          created_by: null,
          approved_by: null,
          business_id: null,
        })),
        restroomAccessPolicies: (policyData || []).map((p: any) => ({
          ...p,
          created_by: null,
        })),
      },
      null,
      2
    ),
    "utf8"
  );
  console.log(
    `원격 이전 선별 패키지 저장 완료 (${exportRows.length}건): ${exportOut}`
  );
}

main().catch((err) => {
  console.error(
    "실행 오류:",
    err instanceof Error ? err.message : String(err)
  );
  process.exit(1);
});
