import type { SupabaseClient } from "@supabase/supabase-js";
import { parseCsv, normalizeRecord } from "./parser";
import {
  type ImportOptions,
  type ImportRunResult,
  type ImportErrorDetail,
  type PublicSourceConfig,
  type ParsedPublicRestroom,
  DEFAULT_SUWON_SOURCE_CONFIG,
} from "./types";

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
 * Ensures idempotency: re-running with the same data produces 0 duplicate records.
 */
export async function importPublicRestrooms(
  supabase: SupabaseClient<any>,
  csvText: string,
  options?: ImportOptions
): Promise<ImportRunResult> {
  const startedAt = new Date().toISOString();
  const rawRecords = parseCsv(csvText);
  const fetchedCount = rawRecords.length;

  const sourceConfig: PublicSourceConfig = {
    ...DEFAULT_SUWON_SOURCE_CONFIG,
    ...options?.sourceConfig,
  };

  const isDryRun = options?.dryRun ?? false;

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
        recordId: raw["화장실관리번호"] || raw["관리번호"] || raw["연번"] || undefined,
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

  // 1.5 Optional address geocoding for records without coordinates
  let geocodeSuccessCount = 0;
  let geocodeFailedCount = 0;

  if (options?.geocoder) {
    const targets = validRecords.filter(
      (r) => r.latitude === null || r.longitude === null
    );
    const concurrency = Math.max(1, options.geocodeConcurrency ?? 5);

    for (let i = 0; i < targets.length; i += concurrency) {
      const batch = targets.slice(i, i + concurrency);
      await Promise.all(
        batch.map(async (record) => {
          const roadAddress = (record.rawMetadata["소재지도로명주소"] || "").trim();
          const jibunAddress = (record.rawMetadata["소재지지번주소"] || "").trim();

          try {
            const geo = await options.geocoder!({
              roadAddress,
              jibunAddress,
              cityFilter: options.cityFilter,
            });

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
    }
  }

  const publishedCount = validRecords.filter((r) => r.publicationStatus === "published").length;
  const draftCount = validRecords.filter((r) => r.publicationStatus === "draft").length;

  if (isDryRun) {
    return {
      runId: "dry-run",
      sourceId: "dry-run",
      status: "success",
      fetchedCount,
      cityMatchedCount,
      duplicateCount,
      geocodeSuccessCount,
      geocodeFailedCount,
      publishedCount,
      draftCount,
      insertedCount: validRecords.length,
      updatedCount: 0,
      skippedCount: initialSkippedCount,
      errorCount: errors.length,
      errors,
      startedAt,
      finishedAt: new Date().toISOString(),
      errorMessage: null,
    };
  }

  // 2. Database integration
  let sourceId = "";
  let runId = "";

  try {
    sourceId = await getOrCreatePublicSource(supabase, sourceConfig);
    runId = await startImportRun(supabase, sourceId);
  } catch (err: any) {
    return {
      runId: "",
      sourceId: "",
      status: "failed",
      fetchedCount,
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

  let insertedCount = 0;
  let updatedCount = 0;
  let skippedCount = initialSkippedCount;

  try {
    for (const record of validRecords) {
      try {
        // Check existing record by (source_id, source_record_id)
        const { data: existing, error: findError } = await supabase
          .from("restrooms")
          .select("id, name, road_address, address_detail, latitude, longitude, gender_type, wheelchair_accessible, baby_changing_available, publication_status")
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

        if (!existing) {
          // INSERT new restroom
          const { data: inserted, error: insertError } = await supabase
            .from("restrooms")
            .insert({
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
            })
            .select("id")
            .single();

          if (insertError || !inserted) {
            errors.push({
              recordId: record.sourceRecordId,
              reason: `화장실 등록 실패: ${insertError?.message}`,
            });
            continue;
          }

          // Insert default free policy for public restroom
          const { error: policyError } = await supabase
            .from("restroom_access_policies")
            .insert({
              restroom_id: inserted.id,
              version: 1,
              access_mode: "free",
              deposit_amount_krw: 0,
              refund_eligible: false,
              is_active: true,
              effective_from: new Date().toISOString(),
            });

          if (policyError) {
            // Log warning but don't fail the whole record
            console.warn(`[Public Import] 무료 정책 생성 경고 (${inserted.id}): ${policyError.message}`);
          }

          insertedCount++;
        } else {
          // Preserve administrative quarantine/archive status
          const preserveAdminStatus = options?.preserveAdminStatus ?? true;
          const isQuarantinedByAdmin =
            preserveAdminStatus &&
            (existing.publication_status === "archived" || existing.publication_status === "suspended");
          const targetStatus = isQuarantinedByAdmin ? existing.publication_status : record.publicationStatus;

          // Check if any field changed
          const isChanged =
            existing.name !== record.name ||
            existing.road_address !== record.roadAddress ||
            (existing.address_detail || null) !== (record.addressDetail || null) ||
            existing.latitude !== record.latitude ||
            existing.longitude !== record.longitude ||
            existing.gender_type !== record.genderType ||
            existing.wheelchair_accessible !== record.wheelchairAccessible ||
            existing.baby_changing_available !== record.babyChangingAvailable ||
            existing.publication_status !== targetStatus;

          if (isChanged) {
            const { error: updateError } = await supabase
              .from("restrooms")
              .update({
                name: record.name,
                description: record.description,
                road_address: record.roadAddress,
                address_detail: record.addressDetail,
                latitude: record.latitude,
                longitude: record.longitude,
                gender_type: record.genderType,
                wheelchair_accessible: record.wheelchairAccessible,
                baby_changing_available: record.babyChangingAvailable,
                publication_status: targetStatus,
                last_verified_at: record.lastVerifiedAt,
              })
              .eq("id", existing.id);

            if (updateError) {
              errors.push({
                recordId: record.sourceRecordId,
                reason: `화장실 정보 갱신 실패: ${updateError.message}`,
              });
              continue;
            }

            updatedCount++;
          } else {
            skippedCount++;
          }
        }
      } catch (recErr: any) {
        errors.push({
          recordId: record.sourceRecordId,
          reason: `처리 중 예외 발생: ${recErr.message || String(recErr)}`,
        });
      }
    }

    const finalStatus: "success" | "failed" =
      errors.length > 0 && insertedCount === 0 && updatedCount === 0 && skippedCount === 0
        ? "failed"
        : "success";

    const finishedAt = new Date().toISOString();

    await finalizeImportRun(supabase, runId, sourceId, {
      status: finalStatus,
      fetchedCount,
      insertedCount,
      updatedCount,
      errorCount: errors.length,
      errorMessage: errors.length > 0 ? `${errors.length}건 처리 오류` : null,
    });

    return {
      runId,
      sourceId,
      status: finalStatus,
      fetchedCount,
      cityMatchedCount,
      duplicateCount,
      geocodeSuccessCount,
      geocodeFailedCount,
      publishedCount,
      draftCount,
      insertedCount,
      updatedCount,
      skippedCount,
      errorCount: errors.length,
      errors,
      startedAt,
      finishedAt,
      errorMessage: errors.length > 0 ? `${errors.length}건 오류 발생` : null,
    };
  } catch (fatalErr: any) {
    const finishedAt = new Date().toISOString();
    await finalizeImportRun(supabase, runId, sourceId, {
      status: "failed",
      fetchedCount,
      insertedCount,
      updatedCount,
      errorCount: errors.length + 1,
      errorMessage: fatalErr.message || String(fatalErr),
    });

    return {
      runId,
      sourceId,
      status: "failed",
      fetchedCount,
      cityMatchedCount,
      duplicateCount,
      geocodeSuccessCount,
      geocodeFailedCount,
      publishedCount,
      draftCount,
      insertedCount,
      updatedCount,
      skippedCount,
      errorCount: errors.length + 1,
      errors: [
        ...errors,
        { reason: `수집 처리 중 치명적 오류: ${fatalErr.message || String(fatalErr)}` },
      ],
      startedAt,
      finishedAt,
      errorMessage: fatalErr.message || String(fatalErr),
    };
  }
}
