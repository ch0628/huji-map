import { describe, expect, it } from "vitest";
import { resolveCompatibleExposureTier } from "../../scripts/address-db-poc/phase3a-lib";
import {
  buildSeoulDescription,
  inferGenderFromOa,
  inferWheelchairFromOa,
  selectSeoulPilotCandidates,
  SEOUL_OA22586_SOURCE_CONFIG,
  validateSeoulPilotPackage,
  type SeoulOaRawRecord,
  type SeoulPilotCandidateInput,
} from "../../scripts/address-db-poc/phase3b-lib";

function makeCandidate(
  overrides: Partial<SeoulPilotCandidateInput> = {}
): SeoulPilotCandidateInput {
  return {
    restroomId: "10000000-0000-4000-8000-000000000001",
    sourceRecordId: "SEOUL-SRC-001",
    name: "강남구청 민원실 화장실",
    sido: "서울특별시",
    sigungu: "강남구",
    roadAddress: "서울특별시 강남구 학동로 426",
    jibunAddress: "서울특별시 강남구 삼성동 16-1",
    baselineStatus: "VERIFIED",
    exposureTier: "FACILITY_PIN",
    coordSource: "seoul_city_location",
    officialLat: 37.517332,
    officialLng: 127.047377,
    officialToMoisDistM: 1.5,
    matchedBuildingMgmtNo: "1168010500100160001000001",
    genderType: "separate",
    wheelchairAccessible: true,
    babyChangingAvailable: false,
    sanitaryProductsAvailable: null,
    description: null,
    ...overrides,
  };
}

function makeOaRecord(
  overrides: Partial<SeoulOaRawRecord> = {}
): SeoulOaRawRecord {
  return {
    seq: "990001",
    roadAddress: "서울특별시 강남구 학동로 426",
    jibunAddress: "서울특별시 강남구 삼성동 16-1",
    lat: 37.517332,
    lng: 127.047377,
    buildingName: "강남구청 민원실 화장실",
    guName: "강남구",
    phone: "02-3423-5000",
    categoryType: "공공개방|",
    openHours: "정시(09:00~18:00,평일)",
    siteUse: "공공기관",
    toiletInfo: "남자(대변기 3, 소변기 4), 여자(대변기 5)",
    disabledInfo: "남자(있음), 여자(있음)",
    extraFacilities: "비상벨",
    signage: "있음",
    siteType: "행정기관",
    notes: "강남구청",
    ...overrides,
  };
}

describe("Phase 3-B Seoul OA-22586 Pilot Selection & Validation", () => {
  it("selects clean official Seoul OA-22586 candidates and excludes MOIS/Kakao/private/risk cases", () => {
    const clean1 = makeCandidate();
    const oa1 = makeOaRecord();

    const clean2 = makeCandidate({
      restroomId: "10000000-0000-4000-8000-000000000002",
      sourceRecordId: "SEOUL-SRC-002",
      name: "서초구립도서관",
      sigungu: "서초구",
      roadAddress: "서울특별시 서초구 반포대로 100",
      officialLat: 37.4835,
      officialLng: 127.0125,
      officialToMoisDistM: 0,
    });
    const oa2 = makeOaRecord({
      seq: "990002",
      buildingName: "서초구립도서관",
      guName: "서초구",
      lat: 37.4835,
      lng: 127.0125,
    });

    const moisBlocked = makeCandidate({
      restroomId: "10000000-0000-4000-8000-000000000003",
      sourceRecordId: "SEOUL-SRC-003",
      coordSource: "mois_address_nav_db",
      officialLat: 37.55,
      officialLng: 127.02,
    });

    const kakaoBlocked = makeCandidate({
      restroomId: "10000000-0000-4000-8000-000000000004",
      sourceRecordId: "SEOUL-SRC-004",
      coordSource: "kakao_geocode",
      officialLat: 37.551,
      officialLng: 127.021,
    });

    const privateBlocked = makeCandidate({
      restroomId: "10000000-0000-4000-8000-000000000005",
      sourceRecordId: "SEOUL-SRC-005",
      name: "민간빌딩 개방화장실",
      sigungu: "송파구",
      officialLat: 37.5145,
      officialLng: 127.1055,
    });
    const oaPrivate = makeOaRecord({
      seq: "990005",
      buildingName: "민간빌딩 개방화장실",
      guName: "송파구",
      lat: 37.5145,
      lng: 127.1055,
      categoryType: "민간개방|",
    });

    const tooFarBlocked = makeCandidate({
      restroomId: "10000000-0000-4000-8000-000000000006",
      sourceRecordId: "SEOUL-SRC-006",
      name: "대형공원 공중화장실",
      sigungu: "마포구",
      officialLat: 37.566,
      officialLng: 126.901,
      officialToMoisDistM: 22.4,
    });
    const oaTooFar = makeOaRecord({
      seq: "990006",
      buildingName: "대형공원 공중화장실",
      guName: "마포구",
      lat: 37.566,
      lng: 126.901,
    });

    // <30m proximity pair (~11m apart)
    const proxA = makeCandidate({
      restroomId: "10000000-0000-4000-8000-000000000007",
      sourceRecordId: "SEOUL-SRC-007",
      name: "근접화장실 A",
      sigungu: "종로구",
      officialLat: 37.57,
      officialLng: 126.976,
    });
    const proxB = makeCandidate({
      restroomId: "10000000-0000-4000-8000-000000000008",
      sourceRecordId: "SEOUL-SRC-008",
      name: "근접화장실 B",
      sigungu: "종로구",
      officialLat: 37.5701,
      officialLng: 126.976,
    });
    const oaProxA = makeOaRecord({
      seq: "990007",
      buildingName: "근접화장실 A",
      guName: "종로구",
      lat: 37.57,
      lng: 126.976,
    });
    const oaProxB = makeOaRecord({
      seq: "990008",
      buildingName: "근접화장실 B",
      guName: "종로구",
      lat: 37.5701,
      lng: 126.976,
    });

    const remoteDup = makeCandidate({
      restroomId: "10000000-0000-4000-8000-000000000009",
      sourceRecordId: "REMOTE-DUP-1",
      name: "기존 원격 화장실",
      sigungu: "용산구",
      officialLat: 37.532,
      officialLng: 126.99,
    });

    const { pkg, excluded, cleanPoolCount } = selectSeoulPilotCandidates(
      [
        clean1,
        clean2,
        moisBlocked,
        kakaoBlocked,
        privateBlocked,
        tooFarBlocked,
        proxA,
        proxB,
        remoteDup,
      ],
      [oa1, oa2, oaPrivate, oaTooFar, oaProxA, oaProxB],
      {
        limit: 50,
        remoteExistingSourceRecordIds: new Set(["REMOTE-DUP-1"]),
      }
    );

    expect(cleanPoolCount).toBe(2);
    expect(pkg.counts.restrooms).toBe(2);
    expect(pkg.counts.policies).toBe(2);
    expect(pkg.counts.candidates).toBe(2);
    expect(pkg.publicDataSource).toEqual(SEOUL_OA22586_SOURCE_CONFIG);

    for (const r of pkg.restrooms) {
      expect(r.type).toBe("public");
      expect(r.access_method).toBe("open");
      expect(r.coordinate_source).toBe("seoul_public_toilet_info");
      expect(r.coordinate_type).toBe("facility_official");
      expect(r.coordinate_verification_status).toBe("VERIFIED");
    }
    for (const p of pkg.restroomAccessPolicies) {
      expect(p.access_mode).toBe("free");
      expect(p.deposit_amount_krw).toBe(0);
      expect(p.refund_eligible).toBe(false);
      expect(p.is_active).toBe(true);
    }

    const reasonMap = new Map(excluded.map((e) => [e.restroomId, e.reason]));
    expect(reasonMap.get(moisBlocked.restroomId)).toContain(
      "unsupported_coord_source:mois_address_nav_db"
    );
    expect(reasonMap.get(kakaoBlocked.restroomId)).toContain(
      "unsupported_coord_source:kakao_geocode"
    );
    expect(reasonMap.get(privateBlocked.restroomId)).toContain(
      "non_public_open_category:민간개방|"
    );
    expect(reasonMap.get(tooFarBlocked.restroomId)).toContain("dist_gt_15m");
    expect(reasonMap.get(proxA.restroomId)).toBe(
      "proximity_lt_30m_duplicate_risk"
    );
    expect(reasonMap.get(proxB.restroomId)).toBe(
      "proximity_lt_30m_duplicate_risk"
    );
    expect(reasonMap.get(remoteDup.restroomId)).toBe("already_on_remote");

    const validation = validateSeoulPilotPackage(
      pkg,
      new Set(),
      new Set(["REMOTE-DUP-1"])
    );
    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });

  it("validateSeoulPilotPackage rejects MOIS/Kakao coordinate sources and non-free policies", () => {
    const { pkg } = selectSeoulPilotCandidates(
      [makeCandidate()],
      [makeOaRecord()],
      { limit: 50 }
    );
    const tampered = structuredClone(pkg);
    (tampered.restrooms[0] as { coordinate_source: string }).coordinate_source =
      "mois_address_nav_db";
    (
      tampered.restroomAccessPolicies[0] as { access_mode: string; deposit_amount_krw: number }
    ).access_mode = "test_deposit";
    (
      tampered.restroomAccessPolicies[0] as { deposit_amount_krw: number }
    ).deposit_amount_krw = 1000;

    const result = validateSeoulPilotPackage(tampered);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("미허용 좌표출처"))).toBe(true);
    expect(result.errors.some((e) => e.includes("무료 정책 위반"))).toBe(true);
  });

  it("enforces exposure gate so unconfirmed published MOIS/Kakao rows remain HIDDEN while Seoul & Suwon stay safe", () => {
    // 1. Seoul OA-22586 published official coordinate -> FACILITY_PIN
    expect(
      resolveCompatibleExposureTier(
        {
          type: "public",
          publication_status: "published",
          latitude: 37.49388797,
          longitude: 127.06427236,
          coordinate_source: "seoul_public_toilet_info",
          coordinate_type: "facility_official",
          coordinate_verification_status: "VERIFIED",
        },
        { moisLicenseCleared: false }
      )
    ).toEqual({ exposureTier: "FACILITY_PIN", blockReason: null });

    // 2. MOIS row accidentally set to published while MOIS license unconfirmed -> HIDDEN
    expect(
      resolveCompatibleExposureTier(
        {
          type: "public",
          publication_status: "published",
          latitude: 37.5,
          longitude: 127.0,
          coordinate_source: "mois_address_nav_db",
          coordinate_type: "building_centroid",
          coordinate_verification_status: "CANDIDATE",
        },
        { moisLicenseCleared: false }
      )
    ).toEqual({
      exposureTier: "HIDDEN",
      blockReason: "mois_license_unconfirmed",
    });

    // 3. Kakao row accidentally set to published -> HIDDEN
    expect(
      resolveCompatibleExposureTier(
        {
          type: "public",
          publication_status: "published",
          latitude: 37.5,
          longitude: 127.0,
          coordinate_source: "kakao_geocode",
          coordinate_type: "geocoded",
          coordinate_verification_status: "CANDIDATE",
        },
        { moisLicenseCleared: false }
      )
    ).toEqual({
      exposureTier: "HIDDEN",
      blockReason: "unverified_or_kakao_source",
    });

    // 4. Legacy Suwon 502 row (coordinate_type=null, gg_publtolt_15011425) -> preserved as FACILITY_PIN
    expect(
      resolveCompatibleExposureTier(
        {
          type: "public",
          publication_status: "published",
          latitude: 37.284,
          longitude: 127.012,
          coordinate_source: "gg_publtolt_15011425",
          coordinate_type: null,
          coordinate_verification_status: null,
        },
        { moisLicenseCleared: false }
      )
    ).toEqual({ exposureTier: "FACILITY_PIN", blockReason: null });

    // 5. Partner restroom remains unaffected
    expect(
      resolveCompatibleExposureTier({
        type: "partner",
        publication_status: "published",
        latitude: 37.2841,
        longitude: 127.0121,
        coordinate_source: "admin_manual",
        coordinate_type: "manual",
        coordinate_verification_status: "VERIFIED",
      })
    ).toEqual({ exposureTier: "FACILITY_PIN", blockReason: null });
  });

  it("correctly infers gender, wheelchair accessibility, and attribution descriptions from OA-22586", () => {
    expect(inferGenderFromOa("남녀공용", null)).toBe("unisex");
    expect(inferGenderFromOa("남자(대1), 여자(대2)", null)).toBe("separate");
    expect(inferWheelchairFromOa("남자(유)|", false)).toBe(true);
    expect(inferWheelchairFromOa("|", false)).toBe(false);

    const desc = buildSeoulDescription(makeOaRecord(), null);
    expect(desc).toContain("출처: 서울특별시 / 서울 열린데이터광장(OA-22586)");
    expect(desc).toContain("개방시간: 정시(09:00~18:00,평일)");
  });
});
