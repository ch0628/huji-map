import fs from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseCsv, normalizeRecord, computeContentHash } from "./parser";
import {
  type ImportOptions,
  type ImportRunResult,
  type ImportErrorDetail,
  type ImportCheckpoint,
  type PublicSourceConfig,
  type ParsedPublicRestroom,
  DEFAULT_SUWON_SOURCE_CONFIG,
} from "./types";

const DEFAULT_BATCH_SIZE = 500;

function writeCheckpointAtomic(
  checkpointPath: string,
  checkpoint: ImportCheckpoint
): void {
  fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
  const tmpPath = `${checkpointPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(checkpoint, null, 2), "utf8");
  fs.renameSync(tmpPath, checkpointPath);
}

function hasValidCoords(row: {
  latitude?: number | null;
  longitude?: number | null;
}): row is { latitude: number; longitude: number } {
  return (
    typeof row.latitude === "number" &&
    typeof row.longitude === "number" &&
    Number.isFinite(row.latitude) &&
    Number.isFinite(row.longitude) &&
    row.latitude > 30 &&
    row.latitude < 45 &&
    row.longitude > 120 &&
    row.longitude < 135
  );
}

interface ExistingRestroomRow {
  id: string;
  source_record_id?: string | null;
  name: string;
  road_address: string;
  address_detail: string | null;
  latitude: number | null;
  longitude: number | null;
  gender_type: string;
  wheelchair_accessible: boolean | null;
  baby_changing_available: boolean | null;
  publication_status: string;
  approved_by?: string | null;
}

const EXISTING_SELECT_COLUMNS =
  "id, source_record_id, name, road_address, address_detail, latitude, longitude, gender_type, wheelchair_accessible, baby_changing_available, publication_status, approved_by";

/**
 * Looks up existing restrooms for a batch by (source_id, source_record_id).
 * Uses batch `.in()` on Supabase/PGlite clients and falls back cleanly for single-row test mocks.
 */
async function fetchExistingBatchMap(
  supabase: SupabaseClient<any>,
  sourceId: string,
  batch: ParsedPublicRestroom[]
): Promise<{
  map: Map<string, ExistingRestroomRow>;
  supportsBatch: boolean;
  errors: ImportErrorDetail[];
}> {
  const map = new Map<string, ExistingRestroomRow>();
  const errors: ImportErrorDetail[] = [];
  if (batch.length === 0) {
    return { map, supportsBatch: true, errors };
  }

  const recordIds = batch.map((r) => r.sourceRecordId);
  const probeChain = supabase
    .from("restrooms")
    .select(EXISTING_SELECT_COLUMNS)
    .eq("source_id", sourceId);

  if (typeof (probeChain as any).in === "function") {
    const { data, error } = await (probeChain as any).in(
      "source_record_id",
      recordIds
    );
    if (error) {
      for (const r of batch) {
        errors.push({
          recordId: r.sourceRecordId,
          reason: `기존 데이터 일괄 조회 실패: ${error.message}`,
        });
      }
      return { map, supportsBatch: true, errors };
    }
    if (Array.isArray(data)) {
      for (const row of data) {
        if (row?.source_record_id) {
          map.set(row.source_record_id, row as ExistingRestroomRow);
        }
      }
    }
    return { map, supportsBatch: true, errors };
  }

  // Fallback for legacy single-row mocks
  for (const record of batch) {
    const { data: existing, error: findError } = await supabase
      .from("restrooms")
      .select(EXISTING_SELECT_COLUMNS)
      .eq("source_id", sourceId)
      .eq("source_record_id", record.sourceRecordId)
      .maybeSingle();

    if (findError) {
      errors.push({
        recordId: record.sourceRecordId,
        reason: `기존 데이터 조회 실패: ${findError.message}`,
      });
      continue;
    }
    if (existing) {
      map.set(record.sourceRecordId, existing as ExistingRestroomRow);
    }
  }

  return { map, supportsBatch: false, errors };
}

/**
 * Inserts free access policies idempotently for newly inserted public restrooms.
 */
async function insertFreePoliciesForRestrooms(
  supabase: SupabaseClient<any>,
  restroomIds: string[]
): Promise<void> {
  if (restroomIds.length === 0) return;

  const effectiveFrom = new Date().toISOString();
  const rows = restroomIds.map((restroomId) => ({
    restroom_id: restroomId,
    version: 1,
    access_mode: "free",
    deposit_amount_krw: 0,
    refund_eligible: false,
    is_active: true,
    effective_from: effectiveFrom,
  }));

  if (rows.length === 1) {
    const { error } = await supabase
      .from("restroom_access_policies")
      .insert(rows[0]);
    if (error) {
      console.warn(
        `[Public Import] 무료 정책 생성 경고 (${restroomIds[0]}): ${error.message}`
      );
    }
    return;
  }

  const { error: batchPolicyError } = await supabase
    .from("restroom_access_policies")
    .insert(rows);

  if (batchPolicyError) {
    for (const row of rows) {
      const { error: singleErr } = await supabase
        .from("restroom_access_policies")
        .insert(row);
      if (singleErr) {
        console.warn(
          `[Public Import] 무료 정책 생성 경고 (${row.restroom_id}): ${singleErr.message}`
        );
      }
    }
  }
}

/**
 * Gets or creates the public data source record in public_data_sources.
 */
export async function getOrCreatePublicSource(
  supabase: SupabaseClient<any>,
  config: PublicSourceConfig
): Promise<string> {
  const { data: existing, error: selectError } = await supabase
    .from("public_data_sources")
    .select("id")
    .eq("provider_name", config.providerName)
    .eq("dataset_name", config.datasetName)
    .maybeSingle();

  if (selectError) {
    throw new Error(`출처 정보 조회 실패: ${selectError.message}`);
  }

  if (existing?.id) {
    return existing.id;
  }

  const { data: inserted, error: insertError } = await supabase
    .from("public_data_sources")
    .insert({
      provider_name: config.providerName,
      dataset_name: config.datasetName,
      source_url: config.sourceUrl,
      api_endpoint: config.apiEndpoint || null,
      license_name: config.licenseName || null,
      license_url: config.licenseUrl || null,
      attribution_text: config.attributionText || null,
    })
    .select("id")
    .single();

  if (insertError || !inserted) {
    throw new Error(`출처 정보 등록 실패: ${insertError?.message}`);
  }

  return inserted.id;
}

/**
 * Creates an import run record with status 'running'.
 */
async function startImportRun(
  supabase: SupabaseClient<any>,
  sourceId: string
): Promise<string> {
  const { data, error } = await supabase
    .from("public_import_runs")
    .insert({
      source_id: sourceId,
      started_at: new Date().toISOString(),
      status: "running",
      fetched_count: 0,
      inserted_count: 0,
      updated_count: 0,
      error_count: 0,
    })
    .select("id")
    .single();

  if (error || !data) {
    throw new Error(`수집 이력 시작 실패: ${error?.message}`);
  }

  return data.id;
}

/**
 * Finalizes an import run record and updates source last_synced_at.
 */
async function finalizeImportRun(
  supabase: SupabaseClient<any>,
  runId: string,
  sourceId: string,
  stats: {
    status: "success" | "failed";
    fetchedCount: number;
    insertedCount: number;
    updatedCount: number;
    errorCount: number;
    errorMessage?: string | null;
  }
): Promise<void> {
  const now = new Date().toISOString();

  await supabase
    .from("public_import_runs")
    .update({
      finished_at: now,
      status: stats.status,
      fetched_count: stats.fetchedCount,
      inserted_count: stats.insertedCount,
      updated_count: stats.updatedCount,
      error_count: stats.errorCount,
      error_message: stats.errorMessage || null,
    })
    .eq("id", runId);

  if (stats.status === "success") {
    await supabase
      .from("public_data_sources")
      .update({ last_synced_at: now })
      .eq("id", sourceId);
  }
}

/**
 * Imports public restrooms from CSV text into Supabase database.
 * Supports:
 * - Batch chunked DB lookup/upsert (default 500 records/batch)
 * - Per-batch Kakao geocoding with quota/rate-limit stop & DB-coordinate reuse
 * - Checkpoint & resume (--resume) across interruptions
 * - Preserving existing coordinates, admin approval, and published/archived/suspended states
 */
export async function importPublicRestrooms(
  supabase: SupabaseClient<any>,
  csvText: string,
  options?: ImportOptions
): Promise<ImportRunResult> {
  const startedAt = new Date().toISOString();
  const rawRecords = parseCsv(csvText);
  const fetchedCount = rawRecords.length;
  const fileSha256 = computeContentHash(csvText);

  const sourceConfig: PublicSourceConfig = {
    ...DEFAULT_SUWON_SOURCE_CONFIG,
    ...options?.sourceConfig,
  };

  const isDryRun = options?.dryRun ?? false;
  const batchSize = Math.max(1, options?.batchSize ?? DEFAULT_BATCH_SIZE);
  const preserveAdminStatus = options?.preserveAdminStatus ?? true;
  const skipUnlocatedNew = options?.skipUnlocatedNew ?? false;
  const regeocodeExisting = options?.regeocodeExisting ?? false;
  const resolvedCheckpointPath = options?.checkpointPath
    ? path.resolve(process.cwd(), options.checkpointPath)
    : null;

  const errors: ImportErrorDetail[] = [];
  const normalizedMap = new Map<string, ParsedPublicRestroom>();
  let initialSkippedCount = 0;
  let cityMatchedCount = 0;
  let duplicateCount = 0;

  // 1. Parse and validate each record
  for (let i = 0; i < rawRecords.length; i++) {
    const raw = rawRecords[i];
    const { parsed, error, skipped } = normalizeRecord(raw, i, {
      cityFilter: options?.cityFilter,
    });

    if (skipped) {
      initialSkippedCount++;
      continue;
    }

    cityMatchedCount++;

    if (error || !parsed) {
      errors.push({
        recordId:
          raw["화장실관리번호"] || raw["관리번호"] || raw["연번"] || undefined,
        line: i + 2,
        reason: error || "알 수 없는 파싱 오류",
      });
      continue;
    }

    // In-batch duplicate handling (keep first)
    if (normalizedMap.has(parsed.sourceRecordId)) {
      duplicateCount++;
      errors.push({
        recordId: parsed.sourceRecordId,
        line: i + 2,
        reason: `입력 데이터 내 중복된 원천 식별자(${parsed.sourceRecordId})입니다. 이전 레코드를 유지합니다.`,
      });
      continue;
    }

    normalizedMap.set(parsed.sourceRecordId, parsed);
  }

  const validRecords = Array.from(normalizedMap.values());
  const totalValidRecords = validRecords.length;

  // 1.2 Load and verify checkpoint when resuming
  let startIndex = 0;
  if (
    options?.resume &&
    resolvedCheckpointPath &&
    fs.existsSync(resolvedCheckpointPath)
  ) {
    let loadedCheckpoint: ImportCheckpoint;
    try {
      loadedCheckpoint = JSON.parse(
        fs.readFileSync(resolvedCheckpointPath, "utf8")
      ) as ImportCheckpoint;
    } catch (cpErr: any) {
      return {
        runId: isDryRun ? "dry-run" : "",
        sourceId: isDryRun ? "dry-run" : "",
        status: "failed",
        fetchedCount,
        cityMatchedCount,
        duplicateCount,
        insertedCount: 0,
        updatedCount: 0,
        skippedCount: initialSkippedCount,
        errorCount: errors.length + 1,
        errors: [
          ...errors,
          {
            reason: `체크포인트 파일 파싱 실패: ${cpErr?.message || String(cpErr)}`,
          },
        ],
        startedAt,
        finishedAt: new Date().toISOString(),
        errorMessage: "체크포인트 파일을 읽을 수 없습니다.",
      };
    }

    const expectedCity = options?.cityFilter ?? null;
    if (
      loadedCheckpoint.fileSha256 !== fileSha256 ||
      loadedCheckpoint.cityFilter !== expectedCity ||
      loadedCheckpoint.totalValidRecords !== totalValidRecords
    ) {
      return {
        runId: isDryRun ? "dry-run" : "",
        sourceId: isDryRun ? "dry-run" : "",
        status: "failed",
        fetchedCount,
        cityMatchedCount,
        duplicateCount,
        insertedCount: 0,
        updatedCount: 0,
        skippedCount: initialSkippedCount,
        errorCount: errors.length + 1,
        errors: [
          ...errors,
          {
            reason:
              "체크포인트가 현재 입력 파일 또는 지역 필터와 일치하지 않습니다. 새 파일이라면 --resume 없이 실행하세요.",
          },
        ],
        startedAt,
        finishedAt: new Date().toISOString(),
        errorMessage: "체크포인트 파일/필터 불일치",
      };
    }

    startIndex = Math.max(
      0,
      Math.min(loadedCheckpoint.nextIndex ?? 0, totalValidRecords)
    );

    if (
      loadedCheckpoint.status === "completed" &&
      startIndex >= totalValidRecords
    ) {
      return {
        runId: isDryRun ? "dry-run" : "resumed-completed",
        sourceId: isDryRun ? "dry-run" : "",
        status: "success",
        fetchedCount,
        cityMatchedCount,
        duplicateCount,
        geocodeSuccessCount: 0,
        geocodeFailedCount: 0,
        skippedUnlocatedNewCount: 0,
        preservedExistingCount: 0,
        publishedCount: 0,
        draftCount: 0,
        insertedCount: 0,
        updatedCount: 0,
        skippedCount: initialSkippedCount,
        errorCount: errors.length,
        errors,
        startedAt,
        finishedAt: new Date().toISOString(),
        errorMessage: null,
        stoppedReason: null,
        resumedFromIndex: startIndex,
        nextIndex: startIndex,
        totalValidRecords,
        geocodeStats: options?.geocoder?.getStats?.() ?? null,
      };
    }
  }

  // 2. Initialize DB run if live
  let sourceId = isDryRun ? "dry-run" : "";
  let runId = isDryRun ? "dry-run" : "";

  if (!isDryRun) {
    try {
      sourceId = await getOrCreatePublicSource(supabase, sourceConfig);
      runId = await startImportRun(supabase, sourceId);
    } catch (err: any) {
      return {
        runId: "",
        sourceId: "",
        status: "failed",
        fetchedCount,
        cityMatchedCount,
        duplicateCount,
        insertedCount: 0,
        updatedCount: 0,
        skippedCount: 0,
        errorCount: errors.length + 1,
        errors: [
          ...errors,
          { reason: `수집 실행 초기화 실패: ${err.message || String(err)}` },
        ],
        startedAt,
        finishedAt: new Date().toISOString(),
        errorMessage: err.message || String(err),
      };
    }
  }

  let insertedCount = 0;
  let updatedCount = 0;
  let skippedCount = initialSkippedCount;
  let skippedUnlocatedNewCount = 0;
  let preservedExistingCount = 0;
  let geocodeSuccessCount = 0;
  let geocodeFailedCount = 0;
  let publishedCount = 0;
  let draftCount = 0;
  let dryRunEligibleCount = 0;
  let nextIndex = startIndex;
  let stoppedReason: string | null = null;
  let stoppedMessage: string | null = null;

  const totalBatches = Math.max(
    1,
    Math.ceil(Math.max(0, totalValidRecords - startIndex) / batchSize)
  );
  const concurrency = Math.max(1, options?.geocodeConcurrency ?? 1);

  try {
    for (
      let batchStart = startIndex, batchIdx = 0;
      batchStart < totalValidRecords;
      batchStart += batchSize, batchIdx++
    ) {
      if (options?.signal?.aborted) {
        stoppedReason = "interrupted";
        stoppedMessage = "사용자 중단 신호(SIGINT/Abort)를 수신해 현재 지점까지 저장 후 정지합니다.";
        break;
      }

      const batch = validRecords.slice(batchStart, batchStart + batchSize);
      const batchExisting = isDryRun
        ? { map: new Map<string, ExistingRestroomRow>(), supportsBatch: true, errors: [] }
        : await fetchExistingBatchMap(supabase, sourceId, batch);

      if (batchExisting.errors.length > 0) {
        errors.push(...batchExisting.errors);
      }

      const existingMap = batchExisting.map;

      // Track DB coordinate preservation BEFORE geocoding to avoid wasting API quota
      const preservedFromDbSet = new Set<string>();
      const needsGeocode: Array<{ idxInBatch: number; record: ParsedPublicRestroom }> = [];

      for (let i = 0; i < batch.length; i++) {
        const record = batch[i];
        if (hasValidCoords(record)) {
          continue;
        }
        const existing = existingMap.get(record.sourceRecordId);
        if (
          existing &&
          hasValidCoords(existing) &&
          !regeocodeExisting
        ) {
          record.latitude = existing.latitude;
          record.longitude = existing.longitude;
          record.publicationStatus =
            existing.publication_status === "archived" ||
            existing.publication_status === "suspended"
              ? "published" // Effective status handled below via preserveAdminStatus
              : "published";
          preservedFromDbSet.add(record.sourceRecordId);
          preservedExistingCount++;
          continue;
        }
        if (options?.geocoder) {
          needsGeocode.push({ idxInBatch: i, record });
        }
      }

      // Per-batch geocoding with graceful stop on quota / rate limit / auth error / signal
      let processedInBatch = batch.length;
      if (options?.geocoder && needsGeocode.length > 0) {
        for (let g = 0; g < needsGeocode.length; g += concurrency) {
          if (options?.signal?.aborted) {
            processedInBatch = needsGeocode[g].idxInBatch;
            stoppedReason = "interrupted";
            stoppedMessage = "사용자 중단 신호를 수신해 지오코딩을 중단하고 진행 상태를 저장합니다.";
            break;
          }

          const microBatch = needsGeocode.slice(g, g + concurrency);
          let fatalHitInMicro: {
            idxInBatch: number;
            reason: string;
            stopReason: string;
          } | null = null;

          await Promise.all(
            microBatch.map(async ({ idxInBatch, record }) => {
              const roadAddress = (
                record.rawMetadata["소재지도로명주소"] || ""
              ).trim();
              const jibunAddress = (
                record.rawMetadata["소재지지번주소"] || ""
              ).trim();
              const agency = (
                record.rawMetadata["관리기관명"] || ""
              ).trim();

              try {
                const geo = await options.geocoder!({
                  roadAddress,
                  jibunAddress,
                  agency: agency || null,
                  cityFilter: options.cityFilter,
                });

                if (geo.fatalStopReason) {
                  if (
                    !fatalHitInMicro ||
                    idxInBatch < fatalHitInMicro.idxInBatch
                  ) {
                    fatalHitInMicro = {
                      idxInBatch,
                      stopReason: geo.fatalStopReason,
                      reason: geo.reason || geo.fatalStopReason,
                    };
                  }
                  return;
                }

                if (
                  geo.status === "success" &&
                  geo.latitude !== null &&
                  geo.longitude !== null &&
                  geo.latitude > 30 &&
                  geo.latitude < 45 &&
                  geo.longitude > 120 &&
                  geo.longitude < 135
                ) {
                  record.latitude = geo.latitude;
                  record.longitude = geo.longitude;
                  record.publicationStatus = "published";
                  geocodeSuccessCount++;
                } else {
                  record.latitude = null;
                  record.longitude = null;
                  record.publicationStatus = "draft";
                  geocodeFailedCount++;
                }
              } catch {
                record.latitude = null;
                record.longitude = null;
                record.publicationStatus = "draft";
                geocodeFailedCount++;
              }
            })
          );

          if (fatalHitInMicro) {
            const hit = fatalHitInMicro as {
              idxInBatch: number;
              reason: string;
              stopReason: string;
            };
            processedInBatch = hit.idxInBatch;
            stoppedReason = hit.stopReason;
            stoppedMessage = hit.reason;
            break;
          }
        }

        options.geocoder.flushCache?.();
        options.geocoder.flushUsage?.();
      }

      const processedBatch = batch.slice(0, processedInBatch);

      if (isDryRun) {
        for (const record of processedBatch) {
          if (skipUnlocatedNew && !hasValidCoords(record)) {
            skippedUnlocatedNewCount++;
            continue;
          }
          dryRunEligibleCount++;
          if (record.publicationStatus === "published") {
            publishedCount++;
          } else {
            draftCount++;
          }
        }
      } else {
        // Prepare inserts & updates
        const toInsert: Array<{
          record: ParsedPublicRestroom;
          payload: Record<string, any>;
        }> = [];
        const toUpdate: Array<{
          id: string;
          sourceRecordId: string;
          patch: Record<string, any>;
        }> = [];

        for (const record of processedBatch) {
          const existing = existingMap.get(record.sourceRecordId);

          if (!existing) {
            if (skipUnlocatedNew && !hasValidCoords(record)) {
              skippedUnlocatedNewCount++;
              continue;
            }
            if (record.publicationStatus === "published") {
              publishedCount++;
            } else {
              draftCount++;
            }
            toInsert.push({
              record,
              payload: {
                type: "public",
                business_id: null,
                source_id: sourceId,
                source_record_id: record.sourceRecordId,
                name: record.name,
                description: record.description,
                road_address: record.roadAddress,
                address_detail: record.addressDetail,
                latitude: record.latitude,
                longitude: record.longitude,
                gender_type: record.genderType,
                wheelchair_accessible: record.wheelchairAccessible,
                baby_changing_available: record.babyChangingAvailable,
                sanitary_products_available: record.sanitaryProductsAvailable,
                access_method: "open",
                publication_status: record.publicationStatus,
                last_verified_at: record.lastVerifiedAt,
              },
            });
          } else {
            // Preserve existing coordinates if incoming has none
            const effectiveLat = hasValidCoords(record)
              ? record.latitude
              : hasValidCoords(existing)
                ? existing.latitude
                : null;
            const effectiveLng = hasValidCoords(record)
              ? record.longitude
              : hasValidCoords(existing)
                ? existing.longitude
                : null;

            const isQuarantinedByAdmin =
              preserveAdminStatus &&
              (existing.publication_status === "archived" ||
                existing.publication_status === "suspended");
            const isApprovedByAdmin =
              preserveAdminStatus &&
              existing.approved_by !== null &&
              existing.approved_by !== undefined;

            let targetStatus: string;
            if (isQuarantinedByAdmin || isApprovedByAdmin) {
              targetStatus = existing.publication_status;
            } else if (effectiveLat !== null && effectiveLng !== null) {
              targetStatus = "published";
            } else if (existing.publication_status === "published") {
              targetStatus = "published";
            } else {
              targetStatus = record.publicationStatus;
            }

            if (targetStatus === "published") {
              publishedCount++;
            } else if (targetStatus === "draft") {
              draftCount++;
            }

            const isChanged =
              existing.name !== record.name ||
              existing.road_address !== record.roadAddress ||
              (existing.address_detail || null) !==
                (record.addressDetail || null) ||
              existing.latitude !== effectiveLat ||
              existing.longitude !== effectiveLng ||
              existing.gender_type !== record.genderType ||
              existing.wheelchair_accessible !== record.wheelchairAccessible ||
              existing.baby_changing_available !==
                record.babyChangingAvailable ||
              existing.publication_status !== targetStatus;

            if (isChanged) {
              toUpdate.push({
                id: existing.id,
                sourceRecordId: record.sourceRecordId,
                patch: {
                  name: record.name,
                  description: record.description,
                  road_address: record.roadAddress,
                  address_detail: record.addressDetail,
                  latitude: effectiveLat,
                  longitude: effectiveLng,
                  gender_type: record.genderType,
                  wheelchair_accessible: record.wheelchairAccessible,
                  baby_changing_available: record.babyChangingAvailable,
                  publication_status: targetStatus,
                  last_verified_at: record.lastVerifiedAt,
                },
              });
            } else {
              skippedCount++;
            }
          }
        }

        // Batch INSERT new restrooms + idempotent free policies
        if (toInsert.length > 0) {
          let batchInserted = false;
          if (batchExisting.supportsBatch && toInsert.length > 1) {
            const { data: insertedRows, error: batchInsertErr } = await supabase
              .from("restrooms")
              .insert(toInsert.map((x) => x.payload))
              .select("id, source_record_id");

            if (!batchInsertErr && Array.isArray(insertedRows)) {
              const insertedIds = insertedRows
                .map((r: any) => r.id)
                .filter((id: unknown): id is string => typeof id === "string");
              await insertFreePoliciesForRestrooms(supabase, insertedIds);
              insertedCount += insertedIds.length;
              batchInserted = true;
            }
          }

          if (!batchInserted) {
            for (const item of toInsert) {
              const { data: inserted, error: insertError } = await supabase
                .from("restrooms")
                .insert(item.payload)
                .select("id")
                .single();

              if (insertError || !inserted) {
                errors.push({
                  recordId: item.record.sourceRecordId,
                  reason: `화장실 등록 실패: ${insertError?.message}`,
                });
                continue;
              }

              await insertFreePoliciesForRestrooms(supabase, [inserted.id]);
              insertedCount++;
            }
          }
        }

        // Update modified existing restrooms
        for (const item of toUpdate) {
          const { error: updateError } = await supabase
            .from("restrooms")
            .update(item.patch)
            .eq("id", item.id);

          if (updateError) {
            errors.push({
              recordId: item.sourceRecordId,
              reason: `화장실 정보 갱신 실패: ${updateError.message}`,
            });
            continue;
          }

          updatedCount++;
        }
      }

      nextIndex = batchStart + processedBatch.length;

      // Save checkpoint after each batch
      if (resolvedCheckpointPath) {
        const cpStatus: ImportCheckpoint["status"] = stoppedReason
          ? stoppedReason === "interrupted"
            ? "interrupted"
            : "paused"
          : nextIndex >= totalValidRecords
            ? "completed"
            : "in_progress";

        writeCheckpointAtomic(resolvedCheckpointPath, {
          version: 1,
          fileSha256,
          cityFilter: options?.cityFilter ?? null,
          batchSize,
          totalValidRecords,
          nextIndex,
          status: cpStatus,
          stoppedReason,
          stats: {
            insertedCount: isDryRun ? dryRunEligibleCount : insertedCount,
            updatedCount,
            skippedCount,
            skippedUnlocatedNewCount,
            preservedExistingCount,
            geocodeSuccessCount,
            geocodeFailedCount,
            errorCount: errors.length,
          },
          updatedAt: new Date().toISOString(),
        });
      }

      const geocodeStats = options?.geocoder?.getStats?.();
      options?.onBatchProgress?.({
        batchIndex: batchIdx + 1,
        totalBatches,
        processedRecords: nextIndex,
        totalValidRecords,
        insertedCount: isDryRun ? dryRunEligibleCount : insertedCount,
        updatedCount,
        skippedCount,
        skippedUnlocatedNewCount,
        geocodeSuccessCount,
        geocodeFailedCount,
        runHttpCalls: geocodeStats?.runHttpCalls ?? 0,
        todayHttpCalls: geocodeStats?.todayHttpCalls ?? 0,
      });

      if (stoppedReason) {
        break;
      }
    }

    const finishedAt = new Date().toISOString();
    const finalStatus: ImportRunResult["status"] =
      stoppedReason === "auth_error"
        ? "failed"
        : stoppedReason
          ? "paused"
          : errors.length > 0 &&
              !isDryRun &&
              insertedCount === 0 &&
              updatedCount === 0 &&
              skippedCount === 0
            ? "failed"
            : "success";

    if (!isDryRun) {
      const dbRunStatus: "success" | "failed" =
        finalStatus === "failed" ? "failed" : "success";
      const runSummaryMsg = stoppedMessage
        ? `${stoppedMessage} (${nextIndex}/${totalValidRecords}건 처리)`
        : errors.length > 0
          ? `${errors.length}건 처리 오류`
          : null;

      await finalizeImportRun(supabase, runId, sourceId, {
        status: dbRunStatus,
        fetchedCount,
        insertedCount,
        updatedCount,
        errorCount: errors.length,
        errorMessage: runSummaryMsg,
      });
    }

    return {
      runId,
      sourceId,
      status: finalStatus,
      fetchedCount,
      cityMatchedCount,
      duplicateCount,
      geocodeSuccessCount,
      geocodeFailedCount,
      skippedUnlocatedNewCount,
      preservedExistingCount,
      publishedCount,
      draftCount,
      insertedCount: isDryRun ? dryRunEligibleCount : insertedCount,
      updatedCount,
      skippedCount,
      errorCount: errors.length,
      errors,
      startedAt,
      finishedAt,
      errorMessage:
        stoppedMessage ??
        (errors.length > 0 ? `${errors.length}건 오류 발생` : null),
      stoppedReason,
      resumedFromIndex: startIndex,
      nextIndex,
      totalValidRecords,
      geocodeStats: options?.geocoder?.getStats?.() ?? null,
    };
  } catch (fatalErr: any) {
    const finishedAt = new Date().toISOString();
    options?.geocoder?.flushCache?.();
    options?.geocoder?.flushUsage?.();

    if (!isDryRun) {
      await finalizeImportRun(supabase, runId, sourceId, {
        status: "failed",
        fetchedCount,
        insertedCount,
        updatedCount,
        errorCount: errors.length + 1,
        errorMessage: fatalErr.message || String(fatalErr),
      });
    }

    return {
      runId,
      sourceId,
      status: "failed",
      fetchedCount,
      cityMatchedCount,
      duplicateCount,
      geocodeSuccessCount,
      geocodeFailedCount,
      skippedUnlocatedNewCount,
      preservedExistingCount,
      publishedCount,
      draftCount,
      insertedCount,
      updatedCount,
      skippedCount,
      errorCount: errors.length + 1,
      errors: [
        ...errors,
        {
          reason: `수집 처리 중 치명적 오류: ${fatalErr.message || String(fatalErr)}`,
        },
      ],
      startedAt,
      finishedAt,
      errorMessage: fatalErr.message || String(fatalErr),
      stoppedReason: "fatal_error",
      resumedFromIndex: startIndex,
      nextIndex,
      totalValidRecords,
      geocodeStats: options?.geocoder?.getStats?.() ?? null,
    };
  }
}
