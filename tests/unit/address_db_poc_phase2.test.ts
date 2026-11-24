import { describe, it, expect } from "vitest";
import { epsg5179ToWgs84, haversineMeters } from "../../scripts/address-db-poc/lib";
import {
  OfficialFacilityIndex,
  classifyRestroomRecord,
  runSelectiveDryRun,
  type CachedMoisMatchRecord,
  type OfficialMatchResult,
} from "../../scripts/address-db-poc/phase2-lib";

function makeBaseMoisRecord(
  overrides: Partial<CachedMoisMatchRecord> = {}
): CachedMoisMatchRecord {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    source_id: "src-1",
    source_record_id: "REC-001",
    name: "행복빌딩",
    road_address: "경기도 부천시 원미구 길주로 100",
    address_detail: "(지번) 경기도 부천시 원미구 중동 1000",
    jibun_address: "(지번) 경기도 부천시 원미구 중동 1000",
    description: null,
    gender_type: "separate",
    wheelchair_accessible: true,
    baby_changing_available: false,
    sanitary_products_available: null,
    access_method: "open",
    publication_status: "published",
    last_verified_at: "2026-02-20T00:00:00+00:00",
    existing_lat: 37.503,
    existing_lng: 126.766,
    existing_coord_source: "kakao_geocode",
    existing_coord_source_id: null,
    existing_coord_source_record_id: null,
    sido: "경기도",
    sigungu: "부천시 원미구",
    admin_dong: "중동",
    summary_status: "unique_match",
    summary_lat: 37.50305,
    summary_lng: 126.76605,
    combined_status: "unique_match",
    combined_match_basis: "road_exact",
    building_count: 1,
    matched_road_pk: "411923180001|0|100|0|4119210100",
    matched_building_mgmt_no: "4119210100110000000000001",
    matched_building_name: "행복빌딩",
    nav_building_use: "근린생활시설",
    nav_is_complex: false,
    has_nav_centroid: true,
    has_nav_entrance: true,
    service_coord_type: "main_entrance",
    service_lat: 37.50305,
    service_lng: 126.76605,
    centroid_pref_lat: 37.50301,
    centroid_pref_lng: 126.76601,
    existing_to_centroid_dist_m: 1.5,
    ...overrides,
  };
}

const NO_OFFICIAL: OfficialMatchResult = {
  matched: false,
  ambiguous: false,
  datasetKey: null,
  sourceRecordId: null,
  matchBasis: null,
  lat: null,
  lng: null,
  dataStdDate: null,
};

describe("Phase 2 — Coordinate Reliability, Protection, and Selective Dry-Run", () => {
  it("never promotes MOIS-only match (even <=1.5m from kakao_geocode) to VERIFIED", () => {
    const rec = makeBaseMoisRecord();
    const res = classifyRestroomRecord(rec, NO_OFFICIAL, {
      sharedAddressCount: 1,
      duplicateGroupCount: 1,
      existingRemoteIds: new Set(),
      moisLicenseCleared: false,
    });
    expect(res.verificationStatus).toBe("CANDIDATE");
    expect(res.publishableNow).toBe(false);
    expect(res.publishBlockReason).toBe("status=CANDIDATE");
  });

  it("assigns VERIFIED only when independent official facility coord + 1:1 MOIS match + zero review flags + <=50m consistency", () => {
    const rec = makeBaseMoisRecord();
    const official: OfficialMatchResult = {
      matched: true,
      ambiguous: false,
      datasetKey: "gg_publtolt_15011425",
      sourceRecordId: "GG-15011425-R10-abc",
      matchBasis: "official_name+road",
      lat: 37.50302,
      lng: 126.76602,
      dataStdDate: "20231219",
    };
    const res = classifyRestroomRecord(rec, official, {
      sharedAddressCount: 1,
      duplicateGroupCount: 1,
      existingRemoteIds: new Set(),
    });
    expect(res.verificationStatus).toBe("VERIFIED");
    expect(res.coordType).toBe("facility_official");
    expect(res.coordSource).toBe("gg_publtolt_15011425");
    expect(res.publishableNow).toBe(true);
  });

  it("flags parks, multi-building complexes, shared addresses, duplicates, and large discrepancies as REVIEW_REQUIRED even with official coords", () => {
    const officialClose: OfficialMatchResult = {
      matched: true,
      ambiguous: false,
      datasetKey: "gg_publtolt_15011425",
      sourceRecordId: "GG-1",
      matchBasis: "official_name+road",
      lat: 37.50302,
      lng: 126.76602,
      dataStdDate: "20231219",
    };

    // Park facility
    const park = classifyRestroomRecord(
      makeBaseMoisRecord({ name: "중앙근린공원 화장실" }),
      officialClose,
      { sharedAddressCount: 1, duplicateGroupCount: 1, existingRemoteIds: new Set() }
    );
    expect(park.verificationStatus).toBe("REVIEW_REQUIRED");
    expect(park.reviewReasons).toContain("PARK_OR_OPEN_SPACE");

    // Multi-building complex without single-building disambiguation
    const complex = classifyRestroomRecord(
      makeBaseMoisRecord({ building_count: 15, matched_building_mgmt_no: null }),
      officialClose,
      { sharedAddressCount: 1, duplicateGroupCount: 1, existingRemoteIds: new Set() }
    );
    expect(complex.verificationStatus).toBe("REVIEW_REQUIRED");
    expect(complex.reviewReasons).toContain("MULTI_BUILDING_COMPLEX");

    // Shared address (>1 restroom at same matched_road_pk)
    const shared = classifyRestroomRecord(
      makeBaseMoisRecord(),
      officialClose,
      { sharedAddressCount: 3, duplicateGroupCount: 1, existingRemoteIds: new Set() }
    );
    expect(shared.verificationStatus).toBe("REVIEW_REQUIRED");
    expect(shared.reviewReasons).toContain("SHARED_ADDRESS_MULTI_RESTROOM");

    // Duplicate suspect
    const dup = classifyRestroomRecord(
      makeBaseMoisRecord(),
      officialClose,
      { sharedAddressCount: 1, duplicateGroupCount: 2, existingRemoteIds: new Set() }
    );
    expect(dup.verificationStatus).toBe("REVIEW_REQUIRED");
    expect(dup.reviewReasons).toContain("DUPLICATE_SUSPECT");

    // Large discrepancy (like Suwon e타운1빌딩 ~5.3km)
    const outlier = classifyRestroomRecord(
      makeBaseMoisRecord({
        name: "e타운1빌딩",
        existing_coord_source: "gg_publtolt_15011425",
        existing_lat: 37.270857,
        existing_lng: 127.009214,
        centroid_pref_lat: 37.23999,
        centroid_pref_lng: 127.05482,
      }),
      {
        ...officialClose,
        datasetKey: "suwon_remote_export",
        lat: 37.270857,
        lng: 127.009214,
      },
      { sharedAddressCount: 1, duplicateGroupCount: 1, existingRemoteIds: new Set(["11111111-1111-1111-1111-111111111111"]) }
    );
    expect(outlier.verificationStatus).toBe("REVIEW_REQUIRED");
    expect(outlier.reviewReasons).toContain("LARGE_OFFICIAL_MOIS_DISCREPANCY");
    expect(outlier.isExistingRemoteSuwon).toBe(true);
  });

  it("blocks 1:N ambiguous matches in OfficialFacilityIndex and classifies ambiguous MOIS matches as REVIEW_REQUIRED", () => {
    const idx = new OfficialFacilityIndex();
    idx.add({
      datasetKey: "gg_publtolt_15011425",
      sourceRecordId: "R1",
      name: "복지관",
      roadAddress: "경기도 부천시 원미구 길주로 100",
      jibunAddress: "",
      lat: 37.503,
      lng: 126.766,
      dataStdDate: "20231219",
      sidoHint: "경기도",
    });
    idx.add({
      datasetKey: "gg_publtolt_15011425",
      sourceRecordId: "R2",
      name: "복지관",
      roadAddress: "경기도 부천시 원미구 길주로 100",
      jibunAddress: "",
      lat: 37.504,
      lng: 126.767,
      dataStdDate: "20231219",
      sidoHint: "경기도",
    });

    const hit = idx.lookup({
      id: "x",
      name: "복지관",
      roadAddress: "경기도 부천시 원미구 길주로 100",
      jibunAddress: "",
      sido: "경기도",
    });
    expect(hit.matched).toBe(false);
    expect(hit.ambiguous).toBe(true);

    const amb = classifyRestroomRecord(
      makeBaseMoisRecord({ combined_status: "ambiguous_match", centroid_pref_lat: null, centroid_pref_lng: null }),
      hit,
      { sharedAddressCount: 1, duplicateGroupCount: 1, existingRemoteIds: new Set() }
    );
    expect(amb.verificationStatus).toBe("REVIEW_REQUIRED");
    expect(amb.reviewReasons).toContain("AMBIGUOUS_ADDRESS_MATCH");
  });

  it("protects existing remote Suwon coords, blocks MOIS-license unverified items, deduplicates, and guarantees idempotent DRY-RUN", () => {
    const suwonExisting = classifyRestroomRecord(
      makeBaseMoisRecord({
        id: "suwon-1",
        source_record_id: "SW-1",
        sido: "경기도",
        sigungu: "수원시 팔달구",
        existing_coord_source: "gg_publtolt_15011425",
      }),
      {
        matched: true,
        ambiguous: false,
        datasetKey: "suwon_remote_export",
        sourceRecordId: "suwon-1",
        matchBasis: "suwon_remote_export_id",
        lat: 37.50302,
        lng: 126.76602,
        dataStdDate: "20231219",
      },
      { sharedAddressCount: 1, duplicateGroupCount: 1, existingRemoteIds: new Set(["suwon-1"]) }
    );

    const bucheonVerified = classifyRestroomRecord(
      makeBaseMoisRecord({
        id: "bucheon-1",
        source_record_id: "BC-1",
        sido: "경기도",
        sigungu: "부천시 원미구",
      }),
      {
        matched: true,
        ambiguous: false,
        datasetKey: "gg_publtolt_15011425",
        sourceRecordId: "GG-BC-1",
        matchBasis: "official_name+road",
        lat: 37.50302,
        lng: 126.76602,
        dataStdDate: "20231219",
      },
      { sharedAddressCount: 1, duplicateGroupCount: 1, existingRemoteIds: new Set(["suwon-1"]) }
    );

    const bucheonDup = { ...bucheonVerified, id: "bucheon-1-dup", sourceRecordId: "BC-2" };

    const moisCandidate = classifyRestroomRecord(
      makeBaseMoisRecord({
        id: "cand-1",
        source_record_id: "CN-1",
        sigungu: "부천시 원미구",
      }),
      NO_OFFICIAL,
      { sharedAddressCount: 1, duplicateGroupCount: 1, existingRemoteIds: new Set(["suwon-1"]) }
    );

    const dry = runSelectiveDryRun(
      [suwonExisting, bucheonVerified, bucheonDup, moisCandidate],
      {
        existingRemoteIds: new Set(["suwon-1"]),
        existingRemoteSourceRecordIds: new Set(["SW-1"]),
        sigunguFilter: ["부천시 원미구", "수원시 팔달구"],
        moisLicenseCleared: false,
      }
    );

    expect(dry.alreadyOnRemoteCount).toBe(1); // suwon-1 protected & skipped
    expect(dry.newToLoadCount).toBe(1); // only bucheonVerified
    expect(dry.skippedDuplicateInBatchCount).toBe(1); // bucheonDup blocked
    expect(dry.skippedNotVerifiedCount).toBe(1); // moisCandidate blocked
    expect(dry.freePolicyToCreateCount).toBe(1);
    expect(dry.idempotentSecondRunNewCount).toBe(0); // 0 new on re-run
    expect(dry.errors).toEqual([]);
  });

  it("verifies EPSG:5179 conversion and distance consistency", () => {
    const p = epsg5179ToWgs84(957149.828039, 1922647.116922);
    expect(p.lat).toBeCloseTo(37.301797, 4);
    expect(p.lng).toBeCloseTo(127.016492, 4);
    expect(haversineMeters(p.lat, p.lng, p.lat, p.lng)).toBe(0);
  });
});
