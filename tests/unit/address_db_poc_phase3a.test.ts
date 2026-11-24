import { describe, it, expect } from "vitest";
import {
  MIGRATION_20261124_ALLOWED_SOURCES,
  REMOTE_20261122_ALLOWED_SOURCES,
  SOURCE_LICENSE_MATRIX,
  assessSuwon502Row,
  buildStaticMapReviewLinks,
  mapPhase2SourceToDbSource,
  resolveCompatibleExposureTier,
} from "../../scripts/address-db-poc/phase3a-lib";

describe("Phase 3-A — License Readiness, Suwon Protection, and DB/API Compatibility", () => {
  it("keeps MOIS UNCONFIRMED, Kakao PROHIBITED, and flags Gyeonggi 15011425 terms conflict", () => {
    const byKey = new Map(SOURCE_LICENSE_MATRIX.map((s) => [s.datasetKey, s]));

    const mois = byKey.get("mois_address_db")!;
    expect(mois.status).toBe("UNCONFIRMED");
    expect(mois.usableForBuildingPinNow).toBe(false);
    expect(mois.usableForFacilityPinNow).toBe(false);

    const kakao = byKey.get("kakao_geocode")!;
    expect(kakao.status).toBe("PROHIBITED_FOR_DB_STORAGE");
    expect(kakao.usableForFacilityPinNow).toBe(false);

    const gg = byKey.get("gg_publtolt_15011425")!;
    expect(gg.status).toBe("PORTAL_NO_RESTRICTION_WITH_TERMS_CONFLICT");
    expect(gg.termsUrl).toBe("https://data.gg.go.kr/portal/termsPolicyPage.do");
    expect(gg.usableForFacilityPinNow).toBe(false);

    expect(byKey.get("seoul_city_location")?.status).toBe("CONFIRMED_NO_RESTRICTION");
    expect(byKey.get("seoul_metro_2026")?.status).toBe("CONFIRMED_NO_RESTRICTION");
    expect(byKey.get("incheon_michuhol_2026")?.status).toBe("CONFIRMED_NO_RESTRICTION");
    expect(byKey.get("incheon_yeonsu_2025")?.status).toBe("UNCONFIRMED");
  });

  it("resolves VERIFIED-only conflict via publication_status + source + type without confusing FACILITY_PIN and BUILDING_PIN", () => {
    // Re-evaluated REVIEW_REQUIRED official facility coord published -> FACILITY_PIN
    expect(
      resolveCompatibleExposureTier({
        type: "public",
        publication_status: "published",
        latitude: 37.2826,
        longitude: 127.0189,
        coordinate_source: "gg_publtolt_15011425",
        coordinate_type: "facility_official",
        coordinate_verification_status: "REVIEW_REQUIRED",
      }).exposureTier
    ).toBe("FACILITY_PIN");

    // Legacy Suwon 502 (coordinate_type=null before 20261124) -> FACILITY_PIN
    expect(
      resolveCompatibleExposureTier({
        type: "public",
        publication_status: "published",
        latitude: 37.284,
        longitude: 127.012,
        coordinate_source: "gg_publtolt_15011425",
        coordinate_type: null,
        coordinate_verification_status: null,
      }).exposureTier
    ).toBe("FACILITY_PIN");

    // Prevent confusing MOIS source with FACILITY_PIN
    const moisAsFacility = resolveCompatibleExposureTier({
      type: "public",
      publication_status: "published",
      latitude: 37.5,
      longitude: 127.0,
      coordinate_source: "mois_address_nav_db",
      coordinate_type: "facility_official",
      coordinate_verification_status: "VERIFIED",
    });
    expect(moisAsFacility.exposureTier).toBe("HIDDEN");
    expect(moisAsFacility.blockReason).toBe("source_mismatch_for_facility_pin");

    // Prevent confusing official source with BUILDING_PIN
    const ggAsBuilding = resolveCompatibleExposureTier(
      {
        type: "public",
        publication_status: "published",
        latitude: 37.5,
        longitude: 127.0,
        coordinate_source: "gg_publtolt_15011425",
        coordinate_type: "building_centroid",
        coordinate_verification_status: "CANDIDATE",
      },
      { moisLicenseCleared: true }
    );
    expect(ggAsBuilding.exposureTier).toBe("HIDDEN");
    expect(ggAsBuilding.blockReason).toBe("source_mismatch_for_building_pin");

    // Block MOIS BUILDING_PIN while license is unconfirmed, allow only when cleared
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
    ).toEqual({ exposureTier: "HIDDEN", blockReason: "mois_license_unconfirmed" });

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
        { moisLicenseCleared: true }
      ).exposureTier
    ).toBe("BUILDING_PIN");

    // Never expose kakao_geocode or complex_centroid_mean
    expect(
      resolveCompatibleExposureTier({
        type: "public",
        publication_status: "published",
        latitude: 37.5,
        longitude: 127.0,
        coordinate_source: "kakao_geocode",
        coordinate_type: "geocoded",
        coordinate_verification_status: null,
      }).exposureTier
    ).toBe("HIDDEN");
  });

  it("maps Phase 2/2.5 dataset keys to 20261124 DB coordinate_source values and detects 20261122 remote gaps", () => {
    const seoulDb = mapPhase2SourceToDbSource("seoul_city_location");
    expect(seoulDb).toBe("seoul_public_toilet_info");
    expect(REMOTE_20261122_ALLOWED_SOURCES.has(seoulDb!)).toBe(false);
    expect(MIGRATION_20261124_ALLOWED_SOURCES.has(seoulDb!)).toBe(true);

    const icnDb = mapPhase2SourceToDbSource("incheon_michuhol_2026");
    expect(icnDb).toBe("incheon_district_public_toilet");
    expect(MIGRATION_20261124_ALLOWED_SOURCES.has(icnDb!)).toBe(true);
  });

  it("preserves all Suwon 502 published rows while classifying correction risks", () => {
    const outlier = assessSuwon502Row({
      restroomId: "1",
      name: "e타운1빌딩",
      exposureTier: "HIDDEN",
      minBuildingDistM: 5343.34,
      baselineReviewReasons: ["LARGE_OFFICIAL_MOIS_DISCREPANCY"],
    });
    expect(outlier.protectionAction).toBe("PRESERVE_PUBLISHED");
    expect(outlier.riskCategory).toBe("CRITICAL_OUTLIER_GT_300M");

    const park = assessSuwon502Row({
      restroomId: "2",
      name: "신대호수",
      exposureTier: "HIDDEN",
      minBuildingDistM: 0.76,
      baselineReviewReasons: ["PARK_OR_OPEN_SPACE", "SHARED_ADDRESS_MULTI_RESTROOM"],
    });
    expect(park.protectionAction).toBe("PRESERVE_PUBLISHED");
    expect(park.riskCategory).toBe("SHARED_PARK_OR_COMPLEX_OFFICE_COPY");

    const redacted = assessSuwon502Row({
      restroomId: "3",
      name: "서호꽃뫼",
      exposureTier: "HIDDEN",
      minBuildingDistM: null,
      baselineReviewReasons: ["REDACTED_OR_INVALID_COORD"],
    });
    expect(redacted.protectionAction).toBe("PRESERVE_PUBLISHED");
    expect(redacted.riskCategory).toBe("MOIS_REDACTED_OR_UNVERIFIED");
  });

  it("builds static review links only for valid Korea WGS84 coordinates", () => {
    const links = buildStaticMapReviewLinks("테스트화장실", 37.5, 127.0);
    expect(links.kakaoMapLink).toContain("37.500000,127.000000");
    expect(links.naverSearchLink).toContain("127.000000,37.500000");
    expect(links.vworldLink).toContain("x=127.000000&y=37.500000");

    expect(buildStaticMapReviewLinks("결측", null, null)).toEqual({
      kakaoMapLink: "",
      naverSearchLink: "",
      vworldLink: "",
    });
  });
});
