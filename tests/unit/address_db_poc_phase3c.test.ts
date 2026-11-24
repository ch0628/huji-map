import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  getPublicRestroomDetail,
  isRestroomCoordinatePubliclyAllowed,
  listPublicRestrooms,
  searchPublicRestroomsByName,
} from "@/lib/restrooms";
import * as serverSupabase from "@/lib/supabase/server";
import {
  applyCanaryReviewGate,
  buildPhase3cMoisFreePackages,
  buildSeoulKogl1Description,
  createInitialCanaryReviewDecisions,
  SEOUL_OA22586_KOGL1_SOURCE_CONFIG,
} from "../../scripts/address-db-poc/phase3c-lib";

describe("Phase 3-C Public Exposure Gate & MOIS-Free Seoul Pilot Safety", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(serverSupabase, "isServiceRoleConfigured").mockReturnValue(false);
  });

  it("enforces coordinate exposure allowlist/blocklist consistently on all types", () => {
    // 1. Legacy Suwon 502 (coordinate_type=null, verification=null) -> ALLOWED
    expect(
      isRestroomCoordinatePubliclyAllowed({
        type: "public",
        coordinate_source: "gg_publtolt_15011425",
        coordinate_type: null,
        coordinate_verification_status: null,
      })
    ).toBe(true);

    // 2. Approved Seoul OA-22586 VERIFIED facility_official -> ALLOWED
    expect(
      isRestroomCoordinatePubliclyAllowed({
        type: "public",
        coordinate_source: "seoul_public_toilet_info",
        coordinate_type: "facility_official",
        coordinate_verification_status: "VERIFIED",
      })
    ).toBe(true);

    // 3. New Seoul row published without VERIFIED or non-official type -> BLOCKED
    expect(
      isRestroomCoordinatePubliclyAllowed({
        type: "public",
        coordinate_source: "seoul_public_toilet_info",
        coordinate_type: "facility_official",
        coordinate_verification_status: "REVIEW_REQUIRED",
      })
    ).toBe(false);
    expect(
      isRestroomCoordinatePubliclyAllowed({
        type: "public",
        coordinate_source: "seoul_public_toilet_info",
        coordinate_type: "facility_official",
        coordinate_verification_status: null,
      })
    ).toBe(false);

    // 4. MOIS unconfirmed coordinates -> BLOCKED even if VERIFIED & published
    expect(
      isRestroomCoordinatePubliclyAllowed({
        type: "public",
        coordinate_source: "mois_address_nav_db",
        coordinate_type: "building_centroid",
        coordinate_verification_status: "VERIFIED",
      })
    ).toBe(false);
    expect(
      isRestroomCoordinatePubliclyAllowed({
        type: "public",
        coordinate_source: "mois_address_summary_db",
        coordinate_type: "main_entrance",
        coordinate_verification_status: "CANDIDATE",
      })
    ).toBe(false);

    // 5. Kakao geocoding -> BLOCKED on both public & partner
    expect(
      isRestroomCoordinatePubliclyAllowed({
        type: "public",
        coordinate_source: "kakao_geocode",
        coordinate_type: "geocoded",
        coordinate_verification_status: "VERIFIED",
      })
    ).toBe(false);
    expect(
      isRestroomCoordinatePubliclyAllowed({
        type: "partner",
        coordinate_source: "kakao_geocode",
        coordinate_type: "geocoded",
        coordinate_verification_status: "VERIFIED",
      })
    ).toBe(false);

    // 6. New public row missing coordinate_source (null) -> BLOCKED
    expect(
      isRestroomCoordinatePubliclyAllowed({
        type: "public",
        coordinate_source: null,
        coordinate_type: null,
        coordinate_verification_status: null,
      })
    ).toBe(false);

    // 7. Existing partner row with null coordinate_source (e.g. 진미 통닭) -> ALLOWED
    expect(
      isRestroomCoordinatePubliclyAllowed({
        type: "partner",
        coordinate_source: null,
        coordinate_type: null,
        coordinate_verification_status: null,
      })
    ).toBe(true);
  });

  it("blocks published MOIS/Kakao/unverified rows from list, search, and detail services without leaking internal fields", async () => {
    const bizId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const rows = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        type: "public",
        name: "수원 기존 화장실",
        description: "수원 502",
        road_address: "경기도 수원시 팔달구 효원로 1",
        address_detail: null,
        latitude: 37.2636,
        longitude: 127.0286,
        access_method: "open",
        gender_type: "separate",
        wheelchair_accessible: true,
        baby_changing_available: false,
        sanitary_products_available: null,
        publication_status: "published",
        last_verified_at: "2026-02-20T00:00:00Z",
        business_id: null,
        coordinate_source: "gg_publtolt_15011425",
        coordinate_type: null,
        coordinate_verification_status: null,
        created_at: "2026-02-20T00:00:00Z",
        updated_at: "2026-02-20T00:00:00Z",
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        type: "public",
        name: "서울 일원본동주민센터",
        description: "출처: 서울특별시",
        road_address: "서울특별시 강남구 광평로 126",
        address_detail: null,
        latitude: 37.265,
        longitude: 127.029,
        access_method: "open",
        gender_type: "separate",
        wheelchair_accessible: true,
        baby_changing_available: false,
        sanitary_products_available: null,
        publication_status: "published",
        last_verified_at: "2026-11-20T00:00:00Z",
        business_id: null,
        coordinate_source: "seoul_public_toilet_info",
        coordinate_type: "facility_official",
        coordinate_verification_status: "VERIFIED",
        coordinate_verification_basis: "internal_secret_basis",
        created_at: "2026-11-20T00:00:00Z",
        updated_at: "2026-11-20T00:00:00Z",
      },
      {
        id: "33333333-3333-4333-8333-333333333333",
        type: "public",
        name: "행안부 미승인 노출시도 화장실",
        description: null,
        road_address: "경기도 수원시 팔달구 2",
        address_detail: null,
        latitude: 37.264,
        longitude: 127.027,
        access_method: "open",
        gender_type: "unknown",
        wheelchair_accessible: null,
        baby_changing_available: null,
        sanitary_products_available: null,
        publication_status: "published",
        last_verified_at: null,
        business_id: null,
        coordinate_source: "mois_address_nav_db",
        coordinate_type: "building_centroid",
        coordinate_verification_status: "CANDIDATE",
        created_at: "2026-11-20T00:00:00Z",
        updated_at: "2026-11-20T00:00:00Z",
      },
      {
        id: "44444444-4444-4444-8444-444444444444",
        type: "public",
        name: "서울 미검증 노출시도 화장실",
        description: null,
        road_address: "경기도 수원시 팔달구 3",
        address_detail: null,
        latitude: 37.266,
        longitude: 127.026,
        access_method: "open",
        gender_type: "unknown",
        wheelchair_accessible: null,
        baby_changing_available: null,
        sanitary_products_available: null,
        publication_status: "published",
        last_verified_at: null,
        business_id: null,
        coordinate_source: "seoul_public_toilet_info",
        coordinate_type: "facility_official",
        coordinate_verification_status: "REVIEW_REQUIRED",
        created_at: "2026-11-20T00:00:00Z",
        updated_at: "2026-11-20T00:00:00Z",
      },
      {
        id: "55555555-5555-4555-8555-555555555555",
        type: "partner",
        name: "진미 통닭",
        description: null,
        road_address: "경기 수원시 팔달구 정조로800번길 21",
        address_detail: null,
        latitude: 37.267,
        longitude: 127.025,
        access_method: "pin",
        gender_type: "unisex",
        wheelchair_accessible: false,
        baby_changing_available: false,
        sanitary_products_available: false,
        publication_status: "published",
        last_verified_at: null,
        business_id: bizId,
        coordinate_source: null,
        coordinate_type: null,
        coordinate_verification_status: null,
        created_at: "2026-11-20T00:00:00Z",
        updated_at: "2026-11-20T00:00:00Z",
      },
    ];

    const fakeSupabase: any = {
      from: (table: string) => {
        let eqId: string | null = null;
        let eqType: string | null = null;
        const chain: any = {
          select: () => chain,
          eq: (col: string, val: any) => {
            if (col === "id") eqId = val;
            if (col === "type") eqType = val;
            return chain;
          },
          gte: () => chain,
          lte: () => chain,
          not: () => chain,
          in: () => chain,
          ilike: () => chain,
          order: () => chain,
          limit: () =>
            Promise.resolve({
              data: rows.filter((r) => (eqType ? r.type === eqType : true)),
              error: null,
            }),
          range: () => {
            const filtered = rows.filter((r) => (eqType ? r.type === eqType : true));
            return Promise.resolve({
              data: filtered,
              count: filtered.length,
              error: null,
            });
          },
          maybeSingle: () => {
            if (table === "feature_flags") {
              return Promise.resolve({ data: { enabled: true }, error: null });
            }
            if (table === "businesses") {
              return Promise.resolve({
                data: {
                  id: bizId,
                  name: "진미 통닭",
                  category: "음식점",
                  description: null,
                  road_address: "수원",
                  jibun_address: null,
                  address_detail: null,
                  latitude: 37.267,
                  longitude: 127.025,
                  phone: null,
                  website_url: null,
                  registration_status: "approved",
                },
                error: null,
              });
            }
            if (table === "restrooms") {
              return Promise.resolve({
                data: rows.find((r) => r.id === eqId) ?? null,
                error: null,
              });
            }
            return Promise.resolve({ data: null, error: null });
          },
          then: (resolve: any) => {
            if (table === "businesses") {
              return Promise.resolve({
                data: [{ id: bizId, name: "진미 통닭", registration_status: "approved" }],
                error: null,
              }).then(resolve);
            }
            return Promise.resolve({ data: [], error: null }).then(resolve);
          },
        };
        return chain;
      },
    };

    const listRes = await listPublicRestrooms(
      fakeSupabase,
      { bbox: "37.25,127.00,37.28,127.05", type: "all", limit: 50, offset: 0 },
      { partnerDiscoveryEnabled: true, businessClient: fakeSupabase }
    );
    expect(listRes.items.map((i) => i.name)).toEqual([
      "수원 기존 화장실",
      "서울 일원본동주민센터",
      "진미 통닭",
    ]);
    // Verify internal provenance fields are NOT leaked to client API DTO
    expect((listRes.items[1] as any).coordinate_verification_basis).toBeUndefined();
    expect((listRes.items[1] as any).coordinate_verification_status).toBeUndefined();

    const searchRes = await searchPublicRestroomsByName(
      fakeSupabase,
      { q: "화장실", type: "all", limit: 10 },
      { partnerDiscoveryEnabled: true, businessClient: fakeSupabase }
    );
    expect(searchRes.items.map((i) => i.name)).toEqual([
      "수원 기존 화장실",
      "서울 일원본동주민센터",
      "진미 통닭",
    ]);

    // Blocked detail returns null even though publication_status='published'
    expect(
      await getPublicRestroomDetail(
        fakeSupabase,
        "33333333-3333-4333-8333-333333333333"
      )
    ).toBeNull();
    expect(
      await getPublicRestroomDetail(
        fakeSupabase,
        "44444444-4444-4444-8444-444444444444"
      )
    ).toBeNull();

    // Approved Seoul detail returns cleanly with attribution in description
    const seoulDetail = await getPublicRestroomDetail(
      fakeSupabase,
      "22222222-2222-4222-8222-222222222222"
    );
    expect(seoulDetail?.name).toBe("서울 일원본동주민센터");
    expect((seoulDetail as any)?.coordinate_verification_basis).toBeUndefined();
  });

  it("embeds KOGL Type 1 attribution, removes MOIS dependency, holds <50m proximity suspects, and builds non-completed human checklists", () => {
    expect(SEOUL_OA22586_KOGL1_SOURCE_CONFIG.licenseName).toContain("공공누리 제1유형");
    expect(SEOUL_OA22586_KOGL1_SOURCE_CONFIG.licenseUrl).toBe(
      "https://www.kogl.or.kr/info/licenseType1.do"
    );
    expect(SEOUL_OA22586_KOGL1_SOURCE_CONFIG.attributionText).toContain("서울특별시");
    expect(SEOUL_OA22586_KOGL1_SOURCE_CONFIG.attributionText).toContain("OA-22586");

    const oaRecords = [
      {
        seq: "1001",
        roadAddress: "서울특별시 강남구 광평로 126",
        jibunAddress: "서울특별시 강남구 일원동 735-3",
        lat: 37.483379,
        lng: 127.086482,
        buildingName: "일원본동주민센터",
        guName: "강남구",
        phone: "02-000-0001",
        categoryType: "공공개방|",
        openHours: "정시(09:00~18:00,평일)",
        siteUse: "행정기관",
        toiletInfo: "남자 여자",
        disabledInfo: "남자 여자",
        extraFacilities: "",
        signage: "있음",
        siteType: "행정",
        notes: "강남구청",
      },
      // Close (<50m) pair in raw OA-22586 even if second row is 민간개방| or has missing road address
      {
        seq: "1002",
        roadAddress: "서울특별시 송파구 올림픽로 300",
        jibunAddress: "서울특별시 송파구 신천동 29",
        lat: 37.513,
        lng: 127.102,
        buildingName: "근접공공화장실",
        guName: "송파구",
        phone: "",
        categoryType: "공공개방|",
        openHours: "상시",
        siteUse: "",
        toiletInfo: "남자 여자",
        disabledInfo: "",
        extraFacilities: "",
        signage: "",
        siteType: "",
        notes: "",
      },
      {
        seq: "1003",
        roadAddress: "",
        jibunAddress: "서울특별시 송파구 신천동 29",
        lat: 37.51318, // ~20m away from 1002
        lng: 127.102,
        buildingName: "근접인접화장실",
        guName: "송파구",
        phone: "",
        categoryType: "민간개방|",
        openHours: "상시",
        siteUse: "",
        toiletInfo: "남자 여자",
        disabledInfo: "",
        extraFacilities: "",
        signage: "",
        siteType: "",
        notes: "",
      },
    ];

    const desc = buildSeoulKogl1Description(oaRecords[0], "2026");
    expect(desc).toContain("공공누리 제1유형");
    expect(desc).toContain("OA-22586");

    const built = buildPhase3cMoisFreePackages({
      oaRecords,
      nationalLinks: [
        {
          restroomId: "aaaa1111-1111-4111-8111-111111111111",
          sourceRecordId: "SRC-1001",
          name: "일원본동주민센터",
          sigungu: "강남구",
          roadAddress: oaRecords[0].roadAddress,
          jibunAddress: oaRecords[0].jibunAddress,
          officialLat: oaRecords[0].lat,
          officialLng: oaRecords[0].lng,
          coordSource: "seoul_city_location",
        },
        {
          restroomId: "aaaa2222-2222-4222-8222-222222222222",
          sourceRecordId: "SRC-1002",
          name: "근접공공화장실",
          sigungu: "송파구",
          roadAddress: oaRecords[1].roadAddress,
          jibunAddress: oaRecords[1].jibunAddress,
          officialLat: oaRecords[1].lat,
          officialLng: oaRecords[1].lng,
          coordSource: "seoul_city_location",
        },
      ],
      remoteRows: [],
      sourceVersion: "2026-11-20",
      sourceFileSha256: "deadbeef",
      lastVerifiedAt: "2026-11-20T00:00:00Z",
    });

    expect(built.pilot50Pkg.moisDependencyRemoved).toBe(true);
    expect(built.pilot50Pkg.restrooms.map((r) => r.name)).toEqual(["일원본동주민센터"]);
    expect(built.canary10Pkg.restrooms.map((r) => r.name)).toEqual(["일원본동주민센터"]);
    expect(built.quarantinedHolds.some((h) => h.oaSeq === "1002" && h.reason === "oa_proximity_lt_50m_hold")).toBe(true);

    const checkRow = built.canary10Checklist[0];
    expect(checkRow.human_verified_complete).toBe(false);
    expect(checkRow.visual_review_status).toBe("PENDING_HUMAN_REVIEW");
    expect(checkRow.non_roadview_fields_status).toBe("NOT_VERIFIABLE_BY_ROADVIEW");
    expect(checkRow.open_hours_verifiable_by_roadview).toBe(false);
    expect(checkRow.kakao_map_review_url).toContain("https://map.kakao.com/link/map/");
    expect(checkRow.naver_map_review_url).toContain("https://map.naver.com/p/search/");
    expect(checkRow.vworld_review_url).toContain("https://map.vworld.kr/map/ws3dmap.do");
  });

  it("holds unreviewed/FAIL/확인 불가 items and keeps only dual-PASS items in Canary review gate", () => {
    const fakePkg: any = {
      generatedAt: "2026-11-22T00:00:00Z",
      pilotTarget: "seoul_oa22586",
      tier: "canary_10",
      moisDependencyRemoved: true,
      sourceVersion: "2026-11-20",
      sourceFileSha256: "deadbeef",
      publicDataSource: SEOUL_OA22586_KOGL1_SOURCE_CONFIG,
      counts: { restrooms: 4, policies: 4, candidates: 4, distinctGus: 4 },
      restrooms: [
        { id: "r1", name: "화장실1", gu_name: "강남구", road_address: "주소1" },
        { id: "r2", name: "화장실2", gu_name: "강북구", road_address: "주소2" },
        { id: "r3", name: "화장실3", gu_name: "강서구", road_address: "주소3" },
        { id: "r4", name: "화장실4", gu_name: "관악구", road_address: "주소4" },
      ],
      restroomAccessPolicies: [
        { restroom_id: "r1", access_mode: "free" },
        { restroom_id: "r2", access_mode: "free" },
        { restroom_id: "r3", access_mode: "free" },
        { restroom_id: "r4", access_mode: "free" },
      ],
      restroomCoordinateCandidates: [
        { restroom_id: "r1" },
        { restroom_id: "r2" },
        { restroom_id: "r3" },
        { restroom_id: "r4" },
      ],
    };

    // Initial state: zero auto-PASS, all 4 held as PENDING
    const initialDecisions = createInitialCanaryReviewDecisions(fakePkg);
    const initialGated = applyCanaryReviewGate(fakePkg, initialDecisions);
    expect(initialGated.summary.approvedReadyCount).toBe(0);
    expect(initialGated.summary.heldCount).toBe(4);
    expect(initialGated.approvedPackage.restrooms).toHaveLength(0);

    // Partial reviews: ONLY r1 has PASS on both buildingLocation & restroomExistenceOpen
    initialDecisions[0].buildingLocationResult = "PASS";
    initialDecisions[0].restroomExistenceOpenResult = "PASS";
    initialDecisions[1].buildingLocationResult = "PASS";
    initialDecisions[1].restroomExistenceOpenResult = "확인 불가";
    initialDecisions[2].buildingLocationResult = "FAIL";
    initialDecisions[2].restroomExistenceOpenResult = "PASS";

    const partialGated = applyCanaryReviewGate(fakePkg, initialDecisions);
    expect(partialGated.summary.approvedReadyCount).toBe(1);
    expect(partialGated.summary.heldCount).toBe(3);
    expect(partialGated.approvedPackage.restrooms.map((r) => r.id)).toEqual(["r1"]);
    expect(partialGated.approvedPackage.restroomAccessPolicies.map((p) => p.restroom_id)).toEqual(["r1"]);
    expect(partialGated.approvedPackage.restroomCoordinateCandidates.map((c) => c.restroom_id)).toEqual(["r1"]);
    expect(partialGated.heldItems.map((h) => [h.restroomId, h.holdReason])).toEqual([
      ["r2", "화장실존재/개방=확인 불가"],
      ["r3", "건물위치=FAIL"],
      ["r4", "건물위치=PENDING, 화장실존재/개방=PENDING"],
    ]);
  });
});
