import { describe, expect, it } from "vitest";
import { isRestroomCoordinatePubliclyAllowed } from "@/lib/restrooms";

const WAVE2_SOURCES = [
  "seoul_park_public_toilet",
  "jeju_public_toilet",
  "daejeon_public_toilet",
  "ulsan_public_toilet",
  "chungbuk_public_toilet",
  "knps_national_park_toilet",
  "mois_bike_trail_toilet",
  "mof_beach_toilet",
  "kex_highway_rest_area_toilet",
] as const;

describe("Wave 2 official coordinate source exposure gate", () => {
  it("allows every Wave 2 official source only when facility_official and VERIFIED", () => {
    for (const source of WAVE2_SOURCES) {
      expect(
        isRestroomCoordinatePubliclyAllowed({
          type: "public",
          coordinate_source: source,
          coordinate_type: "facility_official",
          coordinate_verification_status: "VERIFIED",
        })
      ).toBe(true);

      expect(
        isRestroomCoordinatePubliclyAllowed({
          type: "public",
          coordinate_source: source,
          coordinate_type: "building_centroid",
          coordinate_verification_status: "VERIFIED",
        })
      ).toBe(false);

      expect(
        isRestroomCoordinatePubliclyAllowed({
          type: "public",
          coordinate_source: source,
          coordinate_type: "facility_official",
          coordinate_verification_status: "REVIEW_REQUIRED",
        })
      ).toBe(false);

      expect(
        isRestroomCoordinatePubliclyAllowed({
          type: "public",
          coordinate_source: source,
          coordinate_type: "facility_official",
          coordinate_verification_status: null,
        })
      ).toBe(false);
    }
  });

  it("keeps prohibited MOIS and Kakao coordinate sources blocked", () => {
    for (const blocked of ["kakao_geocode", "mois_address_nav_db", "mois_address_summary_db"]) {
      expect(
        isRestroomCoordinatePubliclyAllowed({
          type: "public",
          coordinate_source: blocked,
          coordinate_type: "facility_official",
          coordinate_verification_status: "VERIFIED",
        })
      ).toBe(false);
    }
  });
});
