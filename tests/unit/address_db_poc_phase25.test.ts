import { describe, it, expect } from "vitest";
import type { CachedMoisMatchRecord } from "../../scripts/address-db-poc/phase2-lib";
import {
  analyzeSharedOfficialCoords,
  classifyPhase25Record,
  deriveExposureTierFromDbMetadata,
  disambiguateComplexBuilding,
  seededSample,
  type NavBuildingSummary,
  type Phase2BaselineInput,
} from "../../scripts/address-db-poc/phase25-lib";

function makeCache(
  overrides: Partial<CachedMoisMatchRecord> = {}
): CachedMoisMatchRecord {
  return {
    id: "id-1",
    source_id: "src-1",
    source_record_id: "REC-1",
    name: "테스트빌딩",
    road_address: "경기도 부천시 원미구 길주로 100",
    address_detail: null,
    jibun_address: "",
    description: null,
    gender_type: "separate",
    wheelchair_accessible: true,
    baby_changing_available: false,
    sanitary_products_available: null,
    access_method: "open",
    publication_status: "published",
    last_verified_at: null,
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
    matched_road_pk: "PK-1",
    matched_building_mgmt_no: "MGMT-1",
    matched_building_name: "테스트빌딩",
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

function makeBaseline(
  overrides: Partial<Phase2BaselineInput> = {}
): Phase2BaselineInput {
  return {
    id: "id-1",
    sourceRecordId: "REC-1",
    name: "테스트빌딩",
    sido: "경기도",
    sigungu: "부천시 원미구",
    roadAddress: "경기도 부천시 원미구 길주로 100",
    jibunAddress: "",
    baselineStatus: "CANDIDATE",
    baselineReviewReasons: [],
    baselineCoordSource: "mois_address_nav_db",
    baselineCoordType: "building_centroid",
    officialLat: null,
    officialLng: null,
    moisLat: 37.50301,
    moisLng: 126.76601,
    officialToMoisDistM: null,
    buildingCount: 1,
    sharedAddressCount: 1,
    duplicateGroupCount: 1,
    isExistingRemoteSuwon: false,
    ...overrides,
  };
}

function makeBldg(
  overrides: Partial<NavBuildingSummary> = {}
): NavBuildingSummary {
  return {
    mgmt: "MGMT-1",
    name: "테스트빌딩",
    detail: "",
    hist: "",
    dhist: "",
    use: "근린생활시설",
    gf: "3",
    uf: "1",
    apt: "0",
    bcnt: "1",
    clat: 37.50301,
    clng: 126.76601,
    elat: 37.50305,
    elng: 126.76605,
    ...overrides,
  };
}

describe("Phase 2.5 — Reclassification & Map Exposure Simulation", () => {
  it("operates identically with zero Kakao inputs (excludes LARGE_KAKAO_MOIS_DISCREPANCY)", () => {
    const base = makeBaseline({
      id: "k-1",
      baselineStatus: "REVIEW_REQUIRED",
      baselineReviewReasons: ["LARGE_KAKAO_MOIS_DISCREPANCY"],
    });
    const cacheWithKakao = makeCache({
      id: "k-1",
      existing_coord_source: "kakao_geocode",
      existing_lat: 35.0,
      existing_lng: 129.0,
      existing_to_centroid_dist_m: 320000,
    });
    const cacheNoKakao = makeCache({
      id: "k-1",
      existing_coord_source: null,
      existing_lat: null,
      existing_lng: null,
      existing_to_centroid_dist_m: null,
    });
    const bldgs = [makeBldg()];
    const emptyShared = {
      suspectIdenticalIds: new Set<string>(),
      sameBuildingSplitIds: new Set<string>(),
    };

    const r1 = classifyPhase25Record(base, cacheWithKakao, bldgs, emptyShared);
    const r2 = classifyPhase25Record(base, cacheNoKakao, bldgs, emptyShared);

    expect(r1.exposureTier).toBe("BUILDING_PIN");
    expect(r1.waterfallStep).toBe(5);
    expect(r1.ruleTag).toBe("kakao_flag_removed_single_bldg");
    expect(r1).toEqual(r2);
  });

  it("promotes multi-building complex with official coord <=100m from individual building to FACILITY_PIN, and blocks >100m outliers", () => {
    const bldgs = [
      makeBldg({ mgmt: "B1", clat: 37.28861, clng: 127.03995 }),
      makeBldg({ mgmt: "B2", clat: 37.2855, clng: 127.0355 }),
    ];
    const cache = makeCache({
      id: "mbc-off-1",
      matched_building_mgmt_no: null,
      building_count: 2,
    });
    const baseClose = makeBaseline({
      id: "mbc-off-1",
      name: "복합문화센터",
      baselineStatus: "REVIEW_REQUIRED",
      baselineReviewReasons: [
        "MULTI_BUILDING_COMPLEX",
        "LARGE_OFFICIAL_MOIS_DISCREPANCY",
      ],
      baselineCoordSource: "gg_publtolt_15011425",
      baselineCoordType: "facility_official",
      officialLat: 37.28862,
      officialLng: 127.03996,
      officialToMoisDistM: 250, // complex mean was 250m away, individual building is ~1.4m
      buildingCount: 2,
    });
    const emptyShared = {
      suspectIdenticalIds: new Set<string>(),
      sameBuildingSplitIds: new Set<string>(),
    };

    const resClose = classifyPhase25Record(baseClose, cache, bldgs, emptyShared);
    expect(resClose.exposureTier).toBe("FACILITY_PIN");
    expect(resClose.waterfallStep).toBe(1);
    expect(resClose.matchedBuildingMgmtNo).toBe("B1");
    expect(resClose.minBuildingDistM!).toBeLessThan(5);

    const baseOutlier = makeBaseline({
      ...baseClose,
      id: "mbc-outlier",
      officialLat: 37.23,
      officialLng: 127.1,
    });
    const resOutlier = classifyPhase25Record(
      baseOutlier,
      makeCache({ id: "mbc-outlier", matched_building_mgmt_no: null, building_count: 2 }),
      bldgs,
      emptyShared
    );
    expect(resOutlier.exposureTier).toBe("HIDDEN");
  });

  it("blocks copy-pasted identical official coords across distinct park/complex facilities while permitting same-building floor splits", () => {
    const cacheMap = new Map<string, CachedMoisMatchRecord>();
    const bldgMap = new Map<string, NavBuildingSummary[]>();

    // Park copy-paste group (광교호수공원 pattern)
    cacheMap.set("p1", makeCache({ id: "p1", matched_road_pk: "PK-PARK" }));
    cacheMap.set("p2", makeCache({ id: "p2", matched_road_pk: "PK-PARK" }));
    bldgMap.set("PK-PARK", [makeBldg({ clat: 37.28067, clng: 127.06599 })]);

    // Stadium distinct gates sharing identical coord in 26-building complex (축구공(감동)/(하나) pattern)
    cacheMap.set(
      "s1",
      makeCache({
        id: "s1",
        matched_road_pk: "PK-STAD",
        matched_building_mgmt_no: null,
        building_count: 2,
      })
    );
    cacheMap.set(
      "s2",
      makeCache({
        id: "s2",
        matched_road_pk: "PK-STAD",
        matched_building_mgmt_no: null,
        building_count: 2,
      })
    );
    bldgMap.set("PK-STAD", [
      makeBldg({ mgmt: "S1", clat: 37.28861, clng: 127.03995 }),
      makeBldg({ mgmt: "S2", clat: 37.28561, clng: 127.03595 }),
    ]);

    // Same-building floor splits (수원화성박물관(1층 좌측)/(2층) pattern)
    cacheMap.set(
      "m1",
      makeCache({
        id: "m1",
        matched_road_pk: "PK-MUS",
        matched_building_mgmt_no: null,
        building_count: 2,
      })
    );
    cacheMap.set(
      "m2",
      makeCache({
        id: "m2",
        matched_road_pk: "PK-MUS",
        matched_building_mgmt_no: null,
        building_count: 2,
      })
    );
    bldgMap.set("PK-MUS", [
      makeBldg({ mgmt: "M1", clat: 37.28268, clng: 127.01899 }),
      makeBldg({ mgmt: "M2", clat: 37.2821, clng: 127.0181 }),
    ]);

    const baselines = [
      makeBaseline({
        id: "p1",
        name: "신대호수",
        baselineStatus: "REVIEW_REQUIRED",
        baselineReviewReasons: ["PARK_OR_OPEN_SPACE", "SHARED_ADDRESS_MULTI_RESTROOM"],
        baselineCoordSource: "suwon_remote_export",
        officialLat: 37.280679,
        officialLng: 127.065992,
      }),
      makeBaseline({
        id: "p2",
        name: "원천호수",
        baselineStatus: "REVIEW_REQUIRED",
        baselineReviewReasons: ["PARK_OR_OPEN_SPACE", "SHARED_ADDRESS_MULTI_RESTROOM"],
        baselineCoordSource: "suwon_remote_export",
        officialLat: 37.280679,
        officialLng: 127.065992,
      }),
      makeBaseline({
        id: "s1",
        name: "축구공(감동)",
        baselineStatus: "REVIEW_REQUIRED",
        baselineReviewReasons: ["MULTI_BUILDING_COMPLEX", "SHARED_ADDRESS_MULTI_RESTROOM"],
        baselineCoordSource: "suwon_remote_export",
        officialLat: 37.288612,
        officialLng: 127.039954,
        buildingCount: 2,
      }),
      makeBaseline({
        id: "s2",
        name: "축구공(하나)",
        baselineStatus: "REVIEW_REQUIRED",
        baselineReviewReasons: ["MULTI_BUILDING_COMPLEX", "SHARED_ADDRESS_MULTI_RESTROOM"],
        baselineCoordSource: "suwon_remote_export",
        officialLat: 37.288612,
        officialLng: 127.039954,
        buildingCount: 2,
      }),
      makeBaseline({
        id: "m1",
        name: "수원화성박물관(1층 좌측)",
        baselineStatus: "REVIEW_REQUIRED",
        baselineReviewReasons: ["MULTI_BUILDING_COMPLEX", "SHARED_ADDRESS_MULTI_RESTROOM"],
        baselineCoordSource: "suwon_remote_export",
        officialLat: 37.282688,
        officialLng: 127.018996,
        buildingCount: 2,
      }),
      makeBaseline({
        id: "m2",
        name: "수원화성박물관(2층)",
        baselineStatus: "REVIEW_REQUIRED",
        baselineReviewReasons: ["MULTI_BUILDING_COMPLEX", "SHARED_ADDRESS_MULTI_RESTROOM"],
        baselineCoordSource: "suwon_remote_export",
        officialLat: 37.282688,
        officialLng: 127.018996,
        buildingCount: 2,
      }),
    ];

    const shared = analyzeSharedOfficialCoords(baselines, cacheMap, bldgMap);
    expect(shared.suspectIdenticalIds.has("p1")).toBe(true);
    expect(shared.suspectIdenticalIds.has("s1")).toBe(true);
    expect(shared.sameBuildingSplitIds.has("m1")).toBe(true);
    expect(shared.sameBuildingSplitIds.has("m2")).toBe(true);

    const p1Res = classifyPhase25Record(
      baselines[0],
      cacheMap.get("p1")!,
      bldgMap.get("PK-PARK")!,
      shared
    );
    const s1Res = classifyPhase25Record(
      baselines[2],
      cacheMap.get("s1")!,
      bldgMap.get("PK-STAD")!,
      shared
    );
    const m1Res = classifyPhase25Record(
      baselines[4],
      cacheMap.get("m1")!,
      bldgMap.get("PK-MUS")!,
      shared
    );

    expect(p1Res.exposureTier).toBe("HIDDEN");
    expect(s1Res.exposureTier).toBe("HIDDEN");
    expect(m1Res.exposureTier).toBe("FACILITY_PIN");
  });

  it("disambiguates multi-building complexes strictly without arbitrary selection and accepts <=20m tight clusters", () => {
    const bldgsCampus = [
      makeBldg({ mgmt: "ENG1", name: "대학교", detail: "제1공학관", clat: 35.1, clng: 129.1 }),
      makeBldg({ mgmt: "ENG2", name: "대학교", detail: "제2공학관", clat: 35.102, clng: 129.102 }),
    ];
    expect(disambiguateComplexBuilding("OO대학교 제1공학관", bldgsCampus)?.building.mgmt).toBe("ENG1");
    expect(disambiguateComplexBuilding("OO대학교 공학관", bldgsCampus)).toBeNull();

    const bldgsTight = [
      makeBldg({ mgmt: "G1", clat: 37.5, clng: 127.0 }),
      makeBldg({ mgmt: "G2", clat: 37.50008, clng: 127.00008 }), // ~11m apart
    ];
    const resTight = classifyPhase25Record(
      makeBaseline({
        id: "tight-1",
        name: "행복주유소",
        baselineStatus: "REVIEW_REQUIRED",
        baselineReviewReasons: ["MULTI_BUILDING_COMPLEX"],
        buildingCount: 2,
      }),
      makeCache({
        id: "tight-1",
        matched_building_mgmt_no: null,
        building_count: 2,
      }),
      bldgsTight,
      { suspectIdenticalIds: new Set(), sameBuildingSplitIds: new Set() }
    );
    expect(resTight.exposureTier).toBe("BUILDING_PIN");
    expect(resTight.ruleTag).toBe("mbc_tight_cluster_20m");
  });

  it("excludes residential apartments from CANDIDATE BUILDING_PIN and holds parks without dedicated toilet buildings", () => {
    const emptyShared = {
      suspectIdenticalIds: new Set<string>(),
      sameBuildingSplitIds: new Set<string>(),
    };

    const aptRes = classifyPhase25Record(
      makeBaseline({ id: "apt-1", baselineStatus: "CANDIDATE" }),
      makeCache({ id: "apt-1" }),
      [makeBldg({ apt: "1", use: "주택" })],
      emptyShared
    );
    expect(aptRes.exposureTier).toBe("HIDDEN");

    const parkMgmt = classifyPhase25Record(
      makeBaseline({
        id: "pk-1",
        name: "중앙근린공원 화장실",
        baselineStatus: "REVIEW_REQUIRED",
        baselineReviewReasons: ["PARK_OR_OPEN_SPACE"],
      }),
      makeCache({ id: "pk-1" }),
      [makeBldg({ name: "공원관리사무소", use: "업무시설" })],
      emptyShared
    );
    expect(parkMgmt.exposureTier).toBe("HIDDEN");

    const parkDedicated = classifyPhase25Record(
      makeBaseline({
        id: "pk-2",
        name: "백세공원",
        baselineStatus: "REVIEW_REQUIRED",
        baselineReviewReasons: ["PARK_OR_OPEN_SPACE"],
      }),
      makeCache({ id: "pk-2" }),
      [makeBldg({ name: "공중화장실", use: "근린생활시설" })],
      emptyShared
    );
    expect(parkDedicated.exposureTier).toBe("BUILDING_PIN");
    expect(parkDedicated.ruleTag).toBe("dedicated_park_toilet_building");
  });

  it("derives exposure tier from 20261124000000 metadata and blocks MOIS publication while license is unconfirmed", () => {
    const candRes = classifyPhase25Record(
      makeBaseline({ id: "c-1", baselineStatus: "CANDIDATE" }),
      makeCache({ id: "c-1" }),
      [makeBldg()],
      { suspectIdenticalIds: new Set(), sameBuildingSplitIds: new Set() },
      { moisLicenseCleared: false }
    );
    expect(candRes.exposureTier).toBe("BUILDING_PIN");
    expect(candRes.publicationEligibleNow).toBe(false);
    expect(candRes.publicationBlockReason).toBe("mois_license_unconfirmed");

    expect(
      deriveExposureTierFromDbMetadata({
        publication_status: "published",
        coordinate_source: "gg_publtolt_15011425",
        coordinate_type: "facility_official",
        coordinate_verification_status: "VERIFIED",
      })
    ).toBe("FACILITY_PIN");

    expect(
      deriveExposureTierFromDbMetadata({
        publication_status: "published",
        coordinate_source: "mois_address_nav_db",
        coordinate_type: "building_centroid",
        coordinate_verification_status: "CANDIDATE",
      })
    ).toBe("BUILDING_PIN");

    expect(
      deriveExposureTierFromDbMetadata({
        publication_status: "published",
        coordinate_source: "kakao_geocode",
        coordinate_type: "geocoded",
        coordinate_verification_status: null,
      })
    ).toBe("HIDDEN");

    expect(
      deriveExposureTierFromDbMetadata({
        publication_status: "published",
        coordinate_source: "mois_address_nav_db",
        coordinate_type: "complex_centroid_mean",
        coordinate_verification_status: "REVIEW_REQUIRED",
      })
    ).toBe("HIDDEN");
  });

  it("samples deterministically with a fixed random seed", () => {
    const items = Array.from({ length: 100 }, (_, i) => `item-${i}`);
    const s1 = seededSample(items, 20, 20261122);
    const s2 = seededSample(items, 20, 20261122);
    const s3 = seededSample(items, 20, 999);
    expect(s1).toHaveLength(20);
    expect(s1).toEqual(s2);
    expect(s1).not.toEqual(s3);
  });
});
