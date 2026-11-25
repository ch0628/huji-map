import { describe, expect, it, vi } from "vitest";
import {
  findIntersectingAdminRegions,
  listViewportUnlocatedCandidates,
  isCandidateDuplicateOfOfficial,
  candidateViewportQuerySchema,
} from "@/lib/restrooms";
import { getAdminRestroomStats } from "@/lib/restrooms/admin-inventory-service";

describe("전국 후보 지역 인덱스 탐색 및 중복 방지 (TASK 3·4)", () => {
  it("시군구 경계 인접 버퍼를 포함해 지도 bounds와 교차하는 행정구역만 탐색한다", () => {
    // 강남구·서초구·송파구 경계 부근 (양재~수서~위례 인접)
    const borderBounds = {
      south: 37.465,
      west: 127.02,
      north: 37.505,
      east: 127.09,
    };
    const regionResult = findIntersectingAdminRegions(borderBounds);
    const regions = regionResult.regions;
    const names = regions.map((r) => `${r.sidoName} ${r.sigunguName}`);

    expect(regionResult.tooWide).toBe(false);
    expect(regions.length).toBeGreaterThanOrEqual(2);
    expect(names.some((n) => n.includes("강남구"))).toBe(true);
    expect(names.some((n) => n.includes("서초구"))).toBe(true);
    // 비관련 먼 지방(예: 부산, 제주)은 포함되지 않음
    expect(names.some((n) => n.includes("제주"))).toBe(false);
    expect(names.some((n) => n.includes("부산"))).toBe(false);
  });

  it("너무 넓은 전국 단위 지도 영역(bbox)은 tooWide=true를 반환하고 DB를 조회하지 않는다", async () => {
    const fromSpy = vi.fn();
    const mockSupabase = { from: fromSpy } as never;

    const result = await listViewportUnlocatedCandidates(mockSupabase, {
      bounds: {
        south: 34.0,
        west: 125.5,
        north: 38.5,
        east: 129.8,
      },
      limit: 20,
    });

    expect(result.tooWide).toBe(true);
    expect(result.items).toEqual([]);
    expect(fromSpy).not.toHaveBeenCalled();
  });

  it("지정된 시군구 코드와 coordinate_status='unlocated' 인덱스로만 조회하고 공식 화장실 중복과 좌표 컬럼 노출을 차단한다", async () => {
    const eqCalls: Array<[string, unknown]> = [];
    const inCalls: Array<[string, unknown]> = [];

    const candidateRows = [
      {
        id: "cand-dup-1",
        source_provider: "전국표준데이터",
        source_dataset_id: "15012892",
        source_record_id: "SUWON-DUP-1",
        name: "수원시청 공중화장실",
        normalized_name: "수원시청 공중화장실",
        road_address: "경기도 수원시 팔달구 효원로 241",
        jibun_address: "경기도 수원시 팔달구 인계동 1111",
        normalized_address: "경기도 수원시 팔달구 효원로 241",
        sido_code: "31",
        sigungu_code: "31013",
        eupmyeondong_code: null,
        sido_name: "경기도",
        sigungu_name: "수원시팔달구",
        eupmyeondong_name: "인계동",
        facility_type: "공중화장실",
        open_hours: "24시간",
        closed_days: "연중무휴",
        gender_type: "separate",
        wheelchair_accessible: true,
        baby_changing_available: true,
        coordinate_status: "unlocated",
        facility_hash: "hash_dup_1234567890abcdef",
        source_base_date: "2026-06-30",
        attribution_text: "수원시",
      },
      {
        id: "cand-valid-2",
        source_provider: "전국표준데이터",
        source_dataset_id: "15012892",
        source_record_id: "SUWON-NEW-2",
        name: "인계예술공원 야외화장실",
        normalized_name: "인계예술공원 야외화장실",
        road_address: "경기도 수원시 팔달구 효원로 307번길 20",
        jibun_address: null,
        normalized_address: "경기도 수원시 팔달구 효원로 307번길 20",
        sido_code: "31",
        sigungu_code: "31013",
        eupmyeondong_code: null,
        sido_name: "경기도",
        sigungu_name: "수원시팔달구",
        eupmyeondong_name: "인계동",
        facility_type: "공중화장실",
        open_hours: "06:00~22:00",
        closed_days: "연중무휴",
        gender_type: "separate",
        wheelchair_accessible: false,
        baby_changing_available: false,
        coordinate_status: "unlocated",
        facility_hash: "hash_new_1234567890abcdef",
        source_base_date: "2026-06-30",
        attribution_text: "수원시",
      },
    ];

    const officialRows = [
      {
        name: "수원시청 공중화장실",
        road_address: "경기도 수원시 팔달구 효원로 241",
      },
    ];

    function makeBuilder(rows: Array<Record<string, unknown>>) {
      let inVals: string[] | null = null;
      const builder = {
        select: () => builder,
        eq: (col: string, val: unknown) => {
          eqCalls.push([col, val]);
          return builder;
        },
        in: (col: string, vals: unknown) => {
          inCalls.push([col, vals]);
          inVals = Array.isArray(vals) ? (vals as string[]) : null;
          return builder;
        },
        gte: () => builder,
        lte: () => builder,
        or: () => builder,
        order: () => builder,
        limit: async () => ({
          data: inVals
            ? rows.filter((r) => inVals!.includes(String(r.sigungu_code)))
            : rows,
          error: null,
        }),
      };
      return builder;
    }

    const mockSupabase = {
      from: (table: string) => {
        if (table === "public_restroom_candidates") {
          return makeBuilder(candidateRows);
        }
        return makeBuilder(officialRows);
      },
    } as never;

    const result = await listViewportUnlocatedCandidates(mockSupabase, {
      bounds: {
        south: 37.255,
        west: 127.02,
        north: 37.272,
        east: 127.042,
      },
      limit: 15,
    });

    expect(result.tooWide).toBe(false);
    expect(eqCalls).toContainEqual(["coordinate_status", "unlocated"]);
    expect(inCalls[0][0]).toBe("sigungu_code");
    expect(Array.isArray(inCalls[0][1])).toBe(true);
    // 중복 후보 cand-dup-1 은 제외되고 cand-valid-2 만 반환
    expect(result.items.map((i) => i.id)).toEqual(["cand-valid-2"]);
    // 후보 객체에는 위경도/지오해시가 절대 포함되지 않음
    const itemRecord = result.items[0] as unknown as Record<string, unknown>;
    expect(itemRecord).not.toHaveProperty("latitude");
    expect(itemRecord).not.toHaveProperty("longitude");
    expect(itemRecord).not.toHaveProperty("geohash");
  });

  it("facility_hash 단독 일치가 아닌 정규화 주소+이름을 검증해 동일 시설만 중복 판별한다", () => {
    const candSameAddrOtherName = {
      name: "서측 주차장 화장실",
      normalized_name: "서측 주차장 화장실",
      road_address: "전북특별자치도 전주시 완산구 기린대로 100",
      jibun_address: null,
      normalized_address: "전북특별자치도 전주시 완산구 기린대로 100",
    };
    const officials = [
      {
        name: "동측 공원 관리사무소",
        road_address: "전북특별자치도 전주시 완산구 기린대로 100",
      },
    ];
    expect(isCandidateDuplicateOfOfficial(candSameAddrOtherName, officials)).toBe(false);

    const candSameFacility = {
      name: "전주시 완산구 기린공원 화장실",
      normalized_name: "전주시 완산구 기린공원 화장실",
      road_address: "전북특별자치도 전주시 완산구 기린대로 100",
      jibun_address: null,
      normalized_address: "전북특별자치도 전주시 완산구 기린대로 100",
    };
    const officialMatch = [
      {
        name: "기린공원 화장실",
        road_address: "전북 전주시 완산구 기린대로 100",
      },
    ];
    expect(isCandidateDuplicateOfOfficial(candSameFacility, officialMatch)).toBe(true);
  });

  it("candidateViewportQuerySchema는 잘못된 bbox 포맷을 차단한다", () => {
    expect(
      candidateViewportQuerySchema.safeParse({ bbox: "invalid" }).success
    ).toBe(false);
    expect(
      candidateViewportQuerySchema.safeParse({ bbox: "38,127,37,128" }).success
    ).toBe(false);
    expect(
      candidateViewportQuerySchema.safeParse({
        bbox: "37.25,127.01,37.28,127.05",
        limit: "15",
      }).success
    ).toBe(true);
  });

  it("관리자 전체 화장실 재고 집계(getAdminRestroomStats)는 public.restrooms만 집계하고 후보 테이블과 분리 관리한다", async () => {
    const queriedTables: string[] = [];
    const mockAdminSupabase = {
      from: (table: string) => {
        queriedTables.push(table);
        if (table === "feature_flags") {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: { enabled: true }, error: null }),
              }),
            }),
          };
        }
        if (table === "businesses") {
          return {
            select: async () => ({
              data: [{ id: "biz-1", name: "진미 통닭", registration_status: "approved" }],
              error: null,
            }),
          };
        }
        if (table === "public_data_sources") {
          return {
            select: async () => ({
              data: [
                {
                  id: "s1",
                  provider_name: "서울특별시",
                  dataset_name: "서울시 공중화장실 위치정보",
                },
              ],
              error: null,
            }),
          };
        }
        const chain = {
          select: () => chain,
          order: () => chain,
          range: async () => ({
            data: [
              {
                id: "r1",
                type: "public",
                publication_status: "published",
                road_address: "서울특별시 중구 세종대로 110",
                address_detail: null,
                latitude: 37.5665,
                longitude: 126.978,
                source_id: "s1",
                coordinate_source_id: "s1",
                coordinate_source: "seoul_public_toilet_info",
                coordinate_type: "facility_official",
                coordinate_verification_status: "VERIFIED",
                coordinate_verification_basis: "FACILITY",
                business_id: null,
              },
              {
                id: "r2",
                type: "partner",
                publication_status: "published",
                road_address: "경기도 수원시 팔달구 정조로 777번길 12",
                address_detail: null,
                latitude: 37.279,
                longitude: 127.018,
                source_id: null,
                coordinate_source_id: null,
                coordinate_source: "partner_kakao_js",
                coordinate_type: null,
                coordinate_verification_status: null,
                coordinate_verification_basis: null,
                business_id: "biz-1",
              },
            ],
            error: null,
          }),
        };
        return chain;
      },
    } as never;

    const summary = await getAdminRestroomStats(mockAdminSupabase);
    expect(queriedTables).toContain("restrooms");
    expect(queriedTables).not.toContain("public_restroom_candidates");
    expect(summary.totalCount).toBe(2);
    expect(summary.mapVisibleCount).toBe(2);
  });
});
