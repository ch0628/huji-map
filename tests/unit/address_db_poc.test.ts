import { describe, it, expect } from "vitest";
import {
  epsg5179ToWgs84,
  parseValidEpsg5179,
  isValidKoreaWgs84,
  haversineMeters,
  parseRoadAddress,
  parseJibunAddress,
  buildRoadKey,
  buildJibunKey,
  parseSummaryRow,
  parseNavBuildRow,
  parseNavJibunRow,
  SummaryAddressIndex,
  NavigationAddressIndex,
  matchRestroomSummaryOnly,
  matchRestroomCombined,
  computeDistanceMetrics,
  type RestroomTarget,
} from "../../scripts/address-db-poc/lib";

describe("Address DB PoC — Coordinate Transform, Distance, Normalization, and Matching", () => {
  it("converts EPSG:5179 (GRS80 UTM-K) to WGS84 accurately and rejects swapped/out-of-bounds coords", () => {
    // Exact projection origin (FE=1000000, FN=2000000) -> (38.0 N, 127.5 E)
    const origin = epsg5179ToWgs84(1_000_000, 2_000_000);
    expect(origin.lat).toBeCloseTo(38.0, 7);
    expect(origin.lng).toBeCloseTo(127.5, 7);

    // Sejong Bangok-dong sample from entrc_sejong.txt
    const sejong = parseValidEpsg5179("983296.172464", "1833330.968984");
    expect(sejong).not.toBeNull();
    expect(sejong!.lat).toBeCloseTo(36.497491, 4);
    expect(sejong!.lng).toBeCloseTo(127.313486, 4);

    // Axis-swapped UTM-K (Y, X) should convert outside Korea or fail bounds check
    const swapped = parseValidEpsg5179("1833330.968984", "983296.172464");
    expect(swapped).toBeNull();

    // Missing / zero / non-numeric coordinates
    expect(parseValidEpsg5179("", "")).toBeNull();
    expect(parseValidEpsg5179("0", "0")).toBeNull();
    expect(parseValidEpsg5179("abc", "1833330")).toBeNull();
    expect(isValidKoreaWgs84(127.0, 37.2)).toBe(false);
  });

  it("computes Haversine geodesic distance accurately", () => {
    expect(haversineMeters(37.2636, 127.0286, 37.2636, 127.0286)).toBe(0);
    // Suwon City Hall (37.2636, 127.0286) to Suwon Station (37.2659, 127.0001) ~ 2.53 km
    const d = haversineMeters(37.2636, 127.0286, 37.2659, 127.0001);
    expect(d).toBeGreaterThan(2450);
    expect(d).toBeLessThan(2600);
  });

  it("never merges distinct road or jibun addresses during normalization", () => {
    const r1 = parseRoadAddress("경기도 수원시 장안구 경수대로 1110");
    const r2 = parseRoadAddress("경기도 수원시 장안구 경수대로 1110-17");
    const r3 = parseRoadAddress("경기도 수원시 장안구 경수대로 지하 1110");
    const r4 = parseRoadAddress("경기도 수원시 장안구 장안로 10");
    const r5 = parseRoadAddress("경기도 수원시 장안구 장안로10번길 10");
    const r6 = parseRoadAddress("경기도 수원시 팔달구 팔달로1가 10");
    const r7 = parseRoadAddress("경기도 수원시 팔달구 팔달로3가 10");

    expect(r1 && r2 && r3 && r4 && r5 && r6 && r7).toBeTruthy();
    expect(buildRoadKey(r1!)).not.toBe(buildRoadKey(r2!));
    expect(buildRoadKey(r1!)).not.toBe(buildRoadKey(r3!));
    expect(buildRoadKey(r4!)).not.toBe(buildRoadKey(r5!));
    expect(buildRoadKey(r6!)).not.toBe(buildRoadKey(r7!));

    // Meaning-preserving spacing & parenthetical normalization should match
    const rA = parseRoadAddress("경기도 수원시 영통구 광교로145");
    const rB = parseRoadAddress("경기도 수원시 영통구 광교로 145 (이의동), 1층");
    expect(rA && rB).toBeTruthy();
    expect(buildRoadKey(rA!)).toBe(buildRoadKey(rB!));

    // Meaning-preserving admin aliases & duplicated prefix cleanup
    const rSpec1 = parseRoadAddress("경기도 수원특례시 권선구 탑동로 57번길 35");
    const rSpec2 = parseRoadAddress("경기도수원시 권선구 수원시 권선구 탑동로57번길 35");
    expect(rSpec1 && rSpec2).toBeTruthy();
    expect(buildRoadKey(rSpec1!)).toBe("경기도|수원시 권선구|탑동로57번길|0|35|0");
    expect(buildRoadKey(rSpec1!)).toBe(buildRoadKey(rSpec2!));

    // Jibun: 산 vs non-산, sub-number, and distinct dong must never merge
    const j1 = parseJibunAddress("(지번) 경기도 수원시 장안구 이목동 110");
    const j2 = parseJibunAddress("(지번) 경기도 수원시 장안구 이목동 산110");
    const j3 = parseJibunAddress("(지번) 경기도 수원시 장안구 이목동 산110-1");
    expect(j1 && j2 && j3).toBeTruthy();
    expect(buildJibunKey(j1!)).not.toBe(buildJibunKey(j2!));
    expect(buildJibunKey(j2!)).not.toBe(buildJibunKey(j3!));

    // Lotless dong-only address must not parse to a matchable jibun
    expect(parseJibunAddress("(지번) 경기도 수원시 팔달구 행궁동")).toBeNull();

    // Dirty regex characters in road names must not throw
    expect(() => parseRoadAddress("경상북도 경주시 ?회재로 10")).not.toThrow();
  });

  it("blocks 1:N ambiguous matches and flags missing_address / invalid_coordinate properly", () => {
    const idx = new SummaryAddressIndex();
    const rowA = parseSummaryRow([
      "41115", "1", "4111510100", "경기도", "수원시 팔달구", "매향동",
      "411153000001", "수원천로", "0", "100", "0", "A동", "16250",
      "근린생활시설", "0", "행궁동", "957000", "1920000",
    ])!;
    const rowB = parseSummaryRow([
      "41115", "2", "4111510200", "경기도", "수원시 팔달구", "북수동",
      "411153000001", "수원천로", "0", "100", "0", "B동", "16250",
      "근린생활시설", "0", "행궁동", "957100", "1920100",
    ])!;
    const rowNoCoord = parseSummaryRow([
      "41115", "3", "4111510300", "경기도", "수원시 팔달구", "화서동",
      "411153000002", "고화로", "0", "120", "0", "비공개건물", "16440",
      "업무시설", "0", "화서1동", "", "",
    ])!;

    idx.add(rowA);
    idx.add(rowB);
    idx.add(rowNoCoord);

    const amb = matchRestroomSummaryOnly(
      {
        id: "t-amb",
        sourceRecordId: "1",
        name: "모호테스트",
        roadAddress: "경기도 수원시 팔달구 수원천로 100",
        jibunAddress: "",
        officialLat: 37.28,
        officialLng: 127.01,
      },
      idx
    );
    expect(amb.status).toBe("ambiguous_match");
    expect(amb.candidateCount).toBe(2);
    expect(amb.matchedLat).toBeNull();

    const miss = matchRestroomSummaryOnly(
      {
        id: "t-miss",
        sourceRecordId: "2",
        name: "주소없음",
        roadAddress: "없음",
        jibunAddress: "",
        officialLat: null,
        officialLng: null,
      },
      idx
    );
    expect(miss.status).toBe("missing_address");

    const inv = matchRestroomSummaryOnly(
      {
        id: "t-inv",
        sourceRecordId: "3",
        name: "좌표결측",
        roadAddress: "경기도 수원시 팔달구 고화로 120",
        jibunAddress: "",
        officialLat: 37.28,
        officialLng: 127.0,
      },
      idx
    );
    expect(inv.status).toBe("invalid_coordinate");
    expect(inv.matchedLat).toBeNull();
  });

  it("resolves jibun-only restrooms when Navigation DB is added and produces deterministic results across re-runs", () => {
    const sumIdx = new SummaryAddressIndex();
    const navIdx = new NavigationAddressIndex();

    const bRow = parseNavBuildRow([
      "4111312800", "경기도", "수원시 권선구", "구운동", "411133180001", "일월로",
      "0", "55", "0", "16419", "4111312800100560001000001", "일월공원관리동",
      "공공용시설", "4111359000", "구운동", "3", "0", "0", "1", "", "", "", "0",
      "953000", "1919000", "953020", "1919015",
      "Gyeonggi-do", "Suwon-si Gwonseon-gu", "Guun-dong", "Ilwol-ro", "1", "",
    ])!;
    const jRow = parseNavJibunRow([
      "4111312800", "경기도", "수원시 권선구", "구운동", "", "0", "56", "1",
      "411133180001", "0", "55", "0", "0",
      "Gyeonggi-do", "Suwon-si Gwonseon-gu", "Guun-dong", "", "",
      "4111312800100560001000001", "4111312800",
    ])!;

    navIdx.addBuild(bRow);
    navIdx.addJibun(jRow);

    const target: RestroomTarget = {
      id: "t-park",
      sourceRecordId: "100",
      name: "텃밭",
      roadAddress: "경기도 수원시 권선구 구운동 56-1(일월공원)",
      jibunAddress: "(지번) 경기도 수원시 권선구 구운동 56-1(일월공원)",
      officialLat: 37.27,
      officialLng: 126.97,
    };

    // Summary-only cannot match jibun-only
    const rSum = matchRestroomSummaryOnly(target, sumIdx);
    expect(rSum.status).toBe("unmatched");

    // Combined resolves via match_jibun + match_build
    const rComb1 = matchRestroomCombined(target, sumIdx, navIdx);
    const rComb2 = matchRestroomCombined(target, sumIdx, navIdx);
    expect(rComb1.status).toBe("unique_match");
    expect(rComb1.matchBasis).toBe("nav_jibun_normalized");
    expect(rComb1.serviceCoordType).toBe("main_entrance");
    expect(rComb1).toEqual(rComb2);

    const stats = computeDistanceMetrics([10, 40, 80, 150, 300]);
    expect(stats.count).toBe(5);
    expect(stats.p50).toBe(80);
    expect(stats.within50mCount).toBe(2);
    expect(stats.within100mCount).toBe(3);
    expect(stats.within200mCount).toBe(4);
  });
});
