import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/db/types";
import { AdminRestroomError } from "./admin-service";
import type {
  AdminRestroomInventoryItem,
  AdminRestroomInventoryResult,
  AdminRestroomRegionStat,
  AdminRestroomSourceCategory,
  AdminRestroomStats,
  AdminRestroomVerificationCategory,
} from "./admin-types";
import type { AdminRestroomInventoryFilter } from "./admin-validation";
import {
  isPartnerRestroomDiscoveryEnabled,
  isRestroomCoordinatePubliclyAllowed,
} from "./service";

const STATS_PAGE_SIZE = 1000;

interface InventoryRowRaw {
  id: string;
  name: string;
  type: "public" | "partner";
  publication_status: "draft" | "pending" | "published" | "suspended" | "archived";
  road_address: string;
  address_detail: string | null;
  latitude: number | null;
  longitude: number | null;
  source_id: string | null;
  coordinate_source_id: string | null;
  coordinate_source: string | null;
  coordinate_type: string | null;
  coordinate_verification_status: string | null;
  coordinate_verification_basis: string | null;
  business_id: string | null;
  last_verified_at: string | null;
  created_at: string;
  updated_at: string;
}

export function sanitizePostgrestIlikeTerm(input: string): string {
  return input.replace(/[%_*,()\\]/g, " ").replace(/\s+/g, " ").trim();
}

export function extractRestroomRegion(
  roadAddress: string | null | undefined,
  addressDetail?: string | null
): { group: "seoul" | "suwon" | "other"; key: string; label: string; seoulGu: string | null } {
  const combined = `${roadAddress ?? ""} ${addressDetail ?? ""}`.trim();

  const seoulMatch = combined.match(/서울(?:특별시|시)?\s+([가-힣]+구)/);
  if (seoulMatch) {
    const gu = seoulMatch[1];
    return {
      group: "seoul",
      key: `seoul:${gu}`,
      label: `서울 ${gu}`,
      seoulGu: gu,
    };
  }
  if (/^서울/.test(combined)) {
    return {
      group: "seoul",
      key: "seoul:기타",
      label: "서울 기타",
      seoulGu: "기타",
    };
  }

  if (/수원(?:시|특례시)/.test(combined)) {
    return {
      group: "suwon",
      key: "suwon",
      label: "경기도 수원시",
      seoulGu: null,
    };
  }

  const otherMatch = combined.match(/([가-힣]+(?:특별시|광역시|특별자치시|도|특별자치도))\s+([가-힣]+(?:시|군|구))/);
  if (otherMatch) {
    const label = `${otherMatch[1]} ${otherMatch[2]}`;
    return {
      group: "other",
      key: `other:${label}`,
      label,
      seoulGu: null,
    };
  }

  return {
    group: "other",
    key: "other:미분류",
    label: "기타 지역",
    seoulGu: null,
  };
}

export function classifyRestroomVerification(
  row: Pick<
    InventoryRowRaw,
    "type" | "coordinate_verification_status" | "coordinate_verification_basis"
  >
): { category: AdminRestroomVerificationCategory; label: string } {
  if (row.type === "partner") {
    return { category: "partner_direct", label: "제휴 매장 등록" };
  }

  const basis = row.coordinate_verification_basis ?? "";
  const vStatus = row.coordinate_verification_status ?? null;

  if (
    vStatus === "VERIFIED" &&
    (basis.includes("FIELD_VERIFIED=true") || basis.includes("POLICY=FIELD_VERIFIED"))
  ) {
    return { category: "field_verified", label: "현장 검증 완료" };
  }

  if (vStatus === "VERIFIED") {
    return { category: "official_validated", label: "공식자료 검증" };
  }

  if (
    vStatus === "REVIEW_REQUIRED" ||
    vStatus === "CANDIDATE" ||
    vStatus === "UNMATCHED"
  ) {
    return { category: "review_required", label: "검토 필요" };
  }

  return { category: "legacy_unset", label: "기존 공식 기준(미기록)" };
}

export function classifyRestroomSource(
  row: Pick<InventoryRowRaw, "type" | "coordinate_source" | "source_id" | "coordinate_source_id">,
  dataSourceMap: Map<string, { provider_name: string; dataset_name: string }>
): { key: AdminRestroomSourceCategory; label: string } {
  if (row.type === "partner") {
    return { key: "partner", label: "제휴 매장 직접 등록" };
  }
  if (row.coordinate_source === "seoul_public_toilet_info") {
    return { key: "seoul_oa22586", label: "서울시 공중화장실 위치정보 (OA-22586)" };
  }
  if (row.coordinate_source === "gg_publtolt_15011425") {
    return { key: "suwon_15011425", label: "수원시 공중화장실 현황 (경기도 15011425 좌표)" };
  }
  const ds =
    (row.source_id ? dataSourceMap.get(row.source_id) : undefined) ??
    (row.coordinate_source_id ? dataSourceMap.get(row.coordinate_source_id) : undefined);
  if (ds) {
    return { key: "other", label: `${ds.provider_name} · ${ds.dataset_name}` };
  }
  return { key: "other", label: "기타 출처" };
}

export function isAdminRestroomMapVisible(
  row: Pick<
    InventoryRowRaw,
    | "type"
    | "publication_status"
    | "latitude"
    | "longitude"
    | "business_id"
    | "coordinate_source"
    | "coordinate_type"
    | "coordinate_verification_status"
  >,
  approvedBusinessIds: Set<string>,
  partnerDiscoveryEnabled: boolean
): boolean {
  if (row.publication_status !== "published") return false;
  if (
    typeof row.latitude !== "number" ||
    !Number.isFinite(row.latitude) ||
    typeof row.longitude !== "number" ||
    !Number.isFinite(row.longitude)
  ) {
    return false;
  }
  if (!isRestroomCoordinatePubliclyAllowed(row)) {
    return false;
  }
  if (row.type === "partner") {
    if (!partnerDiscoveryEnabled) return false;
    return Boolean(row.business_id && approvedBusinessIds.has(row.business_id));
  }
  return true;
}

async function fetchExposureDependencies(supabase: SupabaseClient<Database>) {
  const untyped = supabase as unknown as { from: (table: string) => any };
  const partnerDiscoveryEnabled = await isPartnerRestroomDiscoveryEnabled(supabase);

  const approvedBusinessIds = new Set<string>();
  const businessNameMap = new Map<string, string>();
  const { data: businesses } = await untyped
    .from("businesses")
    .select("id, name, registration_status");
  if (Array.isArray(businesses)) {
    for (const b of businesses) {
      if (b?.id) {
        if (b.name) businessNameMap.set(b.id, b.name);
        if (b.registration_status === "approved") approvedBusinessIds.add(b.id);
      }
    }
  }

  const dataSourceMap = new Map<string, { provider_name: string; dataset_name: string }>();
  const { data: sources } = await untyped
    .from("public_data_sources")
    .select("id, provider_name, dataset_name");
  if (Array.isArray(sources)) {
    for (const s of sources) {
      if (s?.id) {
        dataSourceMap.set(s.id, {
          provider_name: s.provider_name ?? "",
          dataset_name: s.dataset_name ?? "",
        });
      }
    }
  }

  return {
    partnerDiscoveryEnabled,
    approvedBusinessIds,
    businessNameMap,
    dataSourceMap,
  };
}

/**
 * Computes exact live DB restroom aggregations without exposing sensitive payment/PIN tables.
 * Uses chunked pagination so PostgREST's 1,000-row cap never truncates counts.
 */
export async function getAdminRestroomStats(
  supabase: SupabaseClient<Database>
): Promise<AdminRestroomStats> {
  const untyped = supabase as unknown as { from: (table: string) => any };
  const { partnerDiscoveryEnabled, approvedBusinessIds, dataSourceMap } =
    await fetchExposureDependencies(supabase);

  const allRows: InventoryRowRaw[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await untyped
      .from("restrooms")
      .select(
        "id, type, publication_status, road_address, address_detail, latitude, longitude, source_id, coordinate_source_id, coordinate_source, coordinate_type, coordinate_verification_status, coordinate_verification_basis, business_id"
      )
      .order("id", { ascending: true })
      .range(offset, offset + STATS_PAGE_SIZE - 1);

    if (error) {
      throw new AdminRestroomError(
        "STATS_QUERY_FAILED",
        `화장실 통계 집계 조회 실패: ${error.message}`,
        500
      );
    }

    const batch = (data || []) as InventoryRowRaw[];
    allRows.push(...batch);
    if (batch.length < STATS_PAGE_SIZE) break;
    offset += STATS_PAGE_SIZE;
  }

  const byPublicationStatus = {
    published: 0,
    draft: 0,
    pending: 0,
    suspended: 0,
    archived: 0,
  };
  const byType = { public: 0, partner: 0 };
  const regionSummary = { seoulTotal: 0, suwonTotal: 0, otherTotal: 0 };
  const seoulGuMap = new Map<string, AdminRestroomRegionStat>();
  const regionMap = new Map<string, AdminRestroomRegionStat>();
  const sourceMap = new Map<
    AdminRestroomSourceCategory,
    { key: AdminRestroomSourceCategory; label: string; total: number }
  >();
  const byVerificationStatus = {
    fieldVerified: 0,
    officialValidated: 0,
    reviewRequired: 0,
    legacyUnset: 0,
    partnerDirect: 0,
  };

  let mapVisibleCount = 0;

  for (const row of allRows) {
    if (row.type === "public") byType.public += 1;
    else if (row.type === "partner") byType.partner += 1;

    if (row.publication_status in byPublicationStatus) {
      byPublicationStatus[row.publication_status] += 1;
    }

    const visible = isAdminRestroomMapVisible(
      row,
      approvedBusinessIds,
      partnerDiscoveryEnabled
    );
    if (visible) mapVisibleCount += 1;

    const reg = extractRestroomRegion(row.road_address, row.address_detail);
    if (reg.group === "seoul") regionSummary.seoulTotal += 1;
    else if (reg.group === "suwon") regionSummary.suwonTotal += 1;
    else regionSummary.otherTotal += 1;

    const existingReg = regionMap.get(reg.key) ?? {
      key: reg.key,
      label: reg.label,
      total: 0,
      mapVisible: 0,
      publicCount: 0,
      partnerCount: 0,
    };
    existingReg.total += 1;
    if (visible) existingReg.mapVisible += 1;
    if (row.type === "public") existingReg.publicCount += 1;
    else existingReg.partnerCount += 1;
    regionMap.set(reg.key, existingReg);

    if (reg.seoulGu) {
      const guStat = seoulGuMap.get(reg.key) ?? {
        key: reg.key,
        label: reg.label,
        total: 0,
        mapVisible: 0,
        publicCount: 0,
        partnerCount: 0,
      };
      guStat.total += 1;
      if (visible) guStat.mapVisible += 1;
      if (row.type === "public") guStat.publicCount += 1;
      else guStat.partnerCount += 1;
      seoulGuMap.set(reg.key, guStat);
    }

    const src = classifyRestroomSource(row, dataSourceMap);
    const existingSrc = sourceMap.get(src.key) ?? {
      key: src.key,
      label: src.label,
      total: 0,
    };
    existingSrc.total += 1;
    sourceMap.set(src.key, existingSrc);

    const ver = classifyRestroomVerification(row);
    if (ver.category === "field_verified") byVerificationStatus.fieldVerified += 1;
    else if (ver.category === "official_validated") byVerificationStatus.officialValidated += 1;
    else if (ver.category === "review_required") byVerificationStatus.reviewRequired += 1;
    else if (ver.category === "legacy_unset") byVerificationStatus.legacyUnset += 1;
    else byVerificationStatus.partnerDirect += 1;
  }

  const byRegion = Array.from(regionMap.values()).sort(
    (a, b) => b.total - a.total || a.label.localeCompare(b.label, "ko")
  );
  const bySeoulGu = Array.from(seoulGuMap.values()).sort(
    (a, b) => b.total - a.total || a.label.localeCompare(b.label, "ko")
  );
  const byDataSource = Array.from(sourceMap.values()).sort((a, b) => b.total - a.total);

  return {
    totalCount: allRows.length,
    mapVisibleCount,
    hiddenCount: allRows.length - mapVisibleCount,
    partnerDiscoveryEnabled,
    byType,
    byPublicationStatus,
    regionSummary,
    byRegion,
    bySeoulGu,
    byDataSource,
    byVerificationStatus,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Server-filtered, server-sorted, server-paginated admin inventory list.
 * Sends only the requested page slice (default 50) to the browser.
 */
export async function listAdminRestroomInventory(
  supabase: SupabaseClient<Database>,
  filter: AdminRestroomInventoryFilter
): Promise<AdminRestroomInventoryResult> {
  const untyped = supabase as unknown as { from: (table: string) => any };
  const {
    partnerDiscoveryEnabled,
    approvedBusinessIds,
    businessNameMap,
    dataSourceMap,
  } = await fetchExposureDependencies(supabase);

  let query = untyped
    .from("restrooms")
    .select(
      "id, name, type, publication_status, road_address, address_detail, latitude, longitude, source_id, coordinate_source_id, coordinate_source, coordinate_type, coordinate_verification_status, coordinate_verification_basis, business_id, last_verified_at, created_at, updated_at",
      { count: "exact" }
    );

  // 1. Search filter (facility name or road/jibun address)
  if (filter.q) {
    const safeQ = sanitizePostgrestIlikeTerm(filter.q);
    if (safeQ) {
      query = query.or(
        `name.ilike.%${safeQ}%,road_address.ilike.%${safeQ}%,address_detail.ilike.%${safeQ}%`
      );
    }
  }

  // 2. Region filter (must stay consistent with extractRestroomRegion across road_address + address_detail)
  if (filter.region && filter.region !== "all") {
    if (filter.region === "seoul") {
      query = query.or("road_address.ilike.서울%,address_detail.ilike.서울%");
    } else if (filter.region.startsWith("seoul:")) {
      const gu = sanitizePostgrestIlikeTerm(filter.region.slice("seoul:".length));
      if (gu) {
        query = query.or(
          `road_address.ilike.서울%${gu}%,address_detail.ilike.서울%${gu}%`
        );
      }
    } else if (filter.region === "suwon") {
      query = query.or(
        "road_address.ilike.%수원시%,road_address.ilike.%수원특례시%,address_detail.ilike.%수원시%,address_detail.ilike.%수원특례시%"
      );
    } else if (filter.region === "other") {
      query = query
        .not("road_address", "ilike", "서울%")
        .not("road_address", "ilike", "%수원시%")
        .not("road_address", "ilike", "%수원특례시%")
        .or(
          "address_detail.is.null,and(address_detail.not.ilike.서울%,address_detail.not.ilike.%수원시%,address_detail.not.ilike.%수원특례시%)"
        );
    }
  }

  // 3. Type filter
  if (filter.type && filter.type !== "all") {
    query = query.eq("type", filter.type);
  }

  // 4. Publication status filter
  if (filter.status && filter.status !== "all") {
    query = query.eq("publication_status", filter.status);
  }

  // 5. Data source filter
  if (filter.source && filter.source !== "all") {
    if (filter.source === "seoul_oa22586") {
      query = query.eq("coordinate_source", "seoul_public_toilet_info");
    } else if (filter.source === "suwon_15011425") {
      query = query.eq("coordinate_source", "gg_publtolt_15011425");
    } else if (filter.source === "partner") {
      query = query.eq("type", "partner");
    } else if (filter.source === "other") {
      query = query
        .eq("type", "public")
        .or(
          "coordinate_source.is.null,coordinate_source.not.in.(seoul_public_toilet_info,gg_publtolt_15011425)"
        );
    }
  }

  // 6. Coordinate verification status filter
  if (filter.verification && filter.verification !== "all") {
    if (filter.verification === "field_verified") {
      query = query
        .eq("coordinate_verification_status", "VERIFIED")
        .or(
          "coordinate_verification_basis.ilike.%FIELD_VERIFIED=true%,coordinate_verification_basis.ilike.%POLICY=FIELD_VERIFIED%"
        );
    } else if (filter.verification === "official_validated") {
      query = query
        .eq("type", "public")
        .eq("coordinate_verification_status", "VERIFIED")
        .or(
          "coordinate_verification_basis.is.null,coordinate_verification_basis.not.ilike.%FIELD_VERIFIED=true%"
        );
    } else if (filter.verification === "review_required") {
      query = query.in("coordinate_verification_status", [
        "REVIEW_REQUIRED",
        "CANDIDATE",
        "UNMATCHED",
      ]);
    } else if (filter.verification === "legacy_unset") {
      query = query.eq("type", "public").is("coordinate_verification_status", null);
    } else if (filter.verification === "partner_direct") {
      query = query.eq("type", "partner");
    }
  }

  // 7. Deterministic sorting with id tie-breaker so pagination never duplicates or skips rows
  if (filter.sort === "created_asc") {
    query = query.order("created_at", { ascending: true }).order("id", { ascending: true });
  } else if (filter.sort === "name_asc") {
    query = query.order("name", { ascending: true }).order("id", { ascending: true });
  } else if (filter.sort === "name_desc") {
    query = query.order("name", { ascending: false }).order("id", { ascending: true });
  } else {
    query = query.order("created_at", { ascending: false }).order("id", { ascending: true });
  }

  const offset = (filter.page - 1) * filter.limit;
  const { data, error, count } = await query.range(offset, offset + filter.limit - 1);

  if (error) {
    throw new AdminRestroomError(
      "INVENTORY_QUERY_FAILED",
      `전체 화장실 목록 조회 실패: ${error.message}`,
      500
    );
  }

  const rawRows = (data || []) as InventoryRowRaw[];
  const items: AdminRestroomInventoryItem[] = rawRows.map((row) => {
    const reg = extractRestroomRegion(row.road_address, row.address_detail);
    const src = classifyRestroomSource(row, dataSourceMap);
    const ver = classifyRestroomVerification(row);
    const isMapVisible = isAdminRestroomMapVisible(
      row,
      approvedBusinessIds,
      partnerDiscoveryEnabled
    );

    return {
      id: row.id,
      name: row.name,
      type: row.type,
      publication_status: row.publication_status,
      road_address: row.road_address,
      address_detail: row.address_detail,
      region_key: reg.key,
      region_label: reg.label,
      source_key: src.key,
      source_label: src.label,
      coordinate_source: row.coordinate_source,
      coordinate_type: row.coordinate_type,
      coordinate_verification_status: row.coordinate_verification_status,
      verification_category: ver.category,
      verification_label: ver.label,
      is_map_visible: isMapVisible,
      business_id: row.business_id,
      business_name: row.business_id ? businessNameMap.get(row.business_id) ?? null : null,
      last_verified_at: row.last_verified_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  });

  const total = count ?? items.length;
  const totalPages = Math.max(1, Math.ceil(total / filter.limit));

  return {
    items,
    total,
    page: filter.page,
    limit: filter.limit,
    totalPages,
  };
}
