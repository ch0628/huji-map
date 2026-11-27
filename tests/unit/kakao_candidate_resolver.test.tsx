// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  act,
} from "@testing-library/react";
import MapDiscoveryClient from "@/components/map/MapDiscoveryClient";
import type { MapBounds, MapProvider, MarkerOptions } from "@/lib/maps/types";
import {
  createCandidateResolverSessionState,
  resolveViewportCandidatesWithKakao,
  KakaoRateLimitError,
} from "@/lib/maps/candidate-resolver";
import type {
  PublicRestroomCandidateSummary,
  PublicRestroomSummary,
} from "@/lib/restrooms/types";

const OFFICIAL_SUWON: PublicRestroomSummary = {
  id: "official-suwon-1",
  type: "public",
  name: "수원시청 별관 화장실",
  road_address: "경기도 수원시 팔달구 효원로 241",
  address_detail: "1층",
  latitude: 37.2635,
  longitude: 127.0286,
  access_method: "open",
  gender_type: "separate",
  wheelchair_accessible: true,
  baby_changing_available: true,
  sanitary_products_available: null,
  last_verified_at: "2026-06-30",
  business_id: null,
};

const OFFICIAL_PARTNER: PublicRestroomSummary = {
  id: "partner-jinmi-1",
  type: "partner",
  name: "진미 통닭",
  road_address: "경기도 수원시 팔달구 정조로 800번길 21",
  address_detail: "1층 안쪽",
  latitude: 37.279,
  longitude: 127.018,
  access_method: "pin",
  gender_type: "separate",
  wheelchair_accessible: false,
  baby_changing_available: false,
  sanitary_products_available: null,
  last_verified_at: "2026-11-10",
  business_id: "biz-1",
  access_mode: "test_deposit",
  deposit_amount_krw: 1000,
};

function makeCandidate(overrides: Partial<PublicRestroomCandidateSummary> = {}): PublicRestroomCandidateSummary {
  return {
    id: "cand-1",
    source_provider: "전국공중화장실표준데이터",
    source_dataset_id: "15012892",
    source_record_id: "CAND-001",
    name: "효원공원 공중화장실",
    normalized_name: "효원공원 공중화장실",
    road_address: "경기도 수원시 팔달구 동수원로 397",
    jibun_address: "경기도 수원시 팔달구 인계동 1117",
    normalized_address: "경기도 수원시 팔달구 동수원로 397",
    sido_code: "41",
    sigungu_code: "41115",
    eupmyeondong_code: null,
    sido_name: "경기도",
    sigungu_name: "수원시 팔달구",
    eupmyeondong_name: "인계동",
    facility_type: "공중화장실",
    open_hours: "05:00~23:00",
    closed_days: "연중무휴",
    gender_type: "separate",
    wheelchair_accessible: true,
    baby_changing_available: false,
    coordinate_status: "unlocated",
    facility_hash: "hash_hyowon_0000111122223333",
    source_base_date: "2026-06-30",
    attribution_text: "경기도 수원시",
    ...overrides,
  };
}

const TEST_BOUNDS: MapBounds = {
  south: 37.25,
  west: 127.01,
  north: 37.285,
  east: 127.05,
};

function createTestMapProvider(bounds: MapBounds = TEST_BOUNDS) {
  let latestBounds = bounds;
  let markers: MarkerOptions[] = [];

  const provider: MapProvider = {
    name: "mock-test",
    init: async () => {},
    destroy: () => {},
    getCenter: () => ({
      lat: (latestBounds.south + latestBounds.north) / 2,
      lng: (latestBounds.west + latestBounds.east) / 2,
    }),
    setCenter: () => {},
    getZoomLevel: () => 4,
    setZoomLevel: () => {},
    getBounds: () => latestBounds,
    fitBounds: (b) => {
      latestBounds = b;
    },
    setMarkers: (next) => {
      markers = [...next];
    },
    addMarker: () => {},
    removeMarker: () => {},
    clearMarkers: () => {
      markers = [];
    },
    relayout: () => {},
  };

  return {
    provider,
    getMarkers: () => markers,
    setBounds: (nextBounds: MapBounds) => {
      latestBounds = nextBounds;
    },
  };
}

describe("카카오 실시간 위치 보완 모듈 (TASK 5)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("세션 호출 한도(quota), 429 차단, 타임아웃, bounds 검증 및 공식 DB 중복 제거를 수행하며 스토리지에 좌표를 저장하지 않는다", async () => {
    const localSetSpy = vi.spyOn(Storage.prototype, "setItem");

    const sessionState = createCandidateResolverSessionState(10);
    const candidates = [
      // 1) 정상 장소 매칭
      makeCandidate({ id: "c1", name: "효원공원 공중화장실", road_address: "경기도 수원시 팔달구 동수원로 397" }),
      // 2) 공식 DB 핀과 15m 이내 중복 -> 공식 DB 핀 우선으로 제외되어야 함
      makeCandidate({
        id: "c2",
        name: "수원시청 별관 화장실",
        road_address: "경기도 수원시 팔달구 효원로 241",
      }),
      // 3) 다른 시군구/bounds 밖 좌표 반환 -> 검증 실패로 제외되어야 함
      makeCandidate({
        id: "c3",
        name: "강남역 지하화장실",
        sigungu_name: "강남구",
        road_address: "서울특별시 강남구 강남대로 396",
      }),
      // 4) 장소 미매칭 후 지번/도로명 주소 지오코딩 fallback -> 복합시 공백 없는 '수원시팔달구'도 매칭
      makeCandidate({
        id: "c4",
        sigungu_name: "수원시팔달구",
        name: "인계동 주민센터 민원실",
        road_address: "경기도 수원시 팔달구 효원로 281",
      }),
    ];

    const result = await resolveViewportCandidatesWithKakao(candidates, {
      bounds: TEST_BOUNDS,
      officialRestrooms: [OFFICIAL_SUWON],
      sessionState,
      concurrency: 2,
      keywordSearchFn: async (q) => {
        if (q.includes("효원공원")) {
          return [
            {
              name: "효원공원 공중화장실",
              roadAddress: "경기 수원시 팔달구 동수원로 397",
              jibunAddress: "경기 수원시 팔달구 인계동 1117",
              lat: 37.2615,
              lng: 127.0335,
            },
          ];
        }
        if (q.includes("수원시청")) {
          return [
            {
              name: "수원시청 별관 화장실",
              roadAddress: "경기 수원시 팔달구 효원로 241",
              jibunAddress: "",
              lat: 37.26352,
              lng: 127.02861,
            },
          ];
        }
        if (q.includes("강남역")) {
          return [
            {
              name: "강남역 화장실",
              roadAddress: "서울 강남구 강남대로 396",
              jibunAddress: "",
              lat: 37.4979,
              lng: 127.0276, // TEST_BOUNDS 밖
            },
          ];
        }
        return [];
      },
      addressSearchFn: async (addr) => {
        if (addr.includes("효원로 281")) {
          return [
            {
              roadAddress: "경기 수원시 팔달구 효원로 281",
              jibunAddress: "경기 수원시 팔달구 인계동 1120",
              lat: 37.2645,
              lng: 127.032,
            },
          ];
        }
        return [];
      },
    });

    expect(result.aborted).toBe(false);
    expect(result.items.map((i) => i.id)).toEqual(["candidate:c1", "candidate:c4"]);
    expect(result.items[0].location_kind).toBe("candidate_reference");
    expect(result.items[0].location_precision).toBe("kakao_place");
    expect(result.items[1].location_kind).toBe("candidate_reference");
    expect(result.items[1].location_precision).toBe("kakao_address");
    expect(localSetSpy).not.toHaveBeenCalled();

    // 429 발생 시 즉시 보호 중단
    const limitedSession = createCandidateResolverSessionState(50);
    const rateRes = await resolveViewportCandidatesWithKakao(
      [makeCandidate({ id: "c-429" }), makeCandidate({ id: "c-429-2" })],
      {
        bounds: TEST_BOUNDS,
        officialRestrooms: [],
        sessionState: limitedSession,
        keywordSearchFn: async () => {
          throw new KakaoRateLimitError();
        },
        addressSearchFn: async () => [],
      }
    );
    expect(rateRes.rateLimited).toBe(true);
    expect(rateRes.items).toEqual([]);
  });

  it("세션 호출 한도 초과 시 추가 카카오 API 호출을 차단한다", async () => {
    const sessionState = createCandidateResolverSessionState(1);
    sessionState.callsUsed = 1; // 이미 소진

    const kwSpy = vi.fn();
    const res = await resolveViewportCandidatesWithKakao(
      [makeCandidate({ id: "over-quota" })],
      {
        bounds: TEST_BOUNDS,
        officialRestrooms: [],
        sessionState,
        keywordSearchFn: kwSpy,
        addressSearchFn: vi.fn(),
      }
    );

    expect(res.quotaExceeded).toBe(true);
    expect(kwSpy).not.toHaveBeenCalled();
  });

  it("주소 품질에 따라 addressSearch/keywordSearch 순서를 동적으로 선택하고 일시 실패만 재시도 대상으로 분리한다", async () => {
    const sessionState = createCandidateResolverSessionState(20);
    const callLog: string[] = [];
    const streamedIds: string[] = [];

    // 1) 번호 있는 도로명 주소 + 일반 건물명 -> addressSearch 먼저 1회만 호출 (keywordSearch 생략)
    const addrFirstCand = makeCandidate({
      id: "cand-addr-first",
      name: "삼성애니텔",
      road_address: "경기도 수원시 팔달구 효원로 255, 삼성애니텔 (인계동)",
    });
    // 2) 고유 POI(공원) -> keywordSearch 먼저 1회만 호출 (addressSearch 생략)
    const poiFirstCand = makeCandidate({
      id: "cand-poi-first",
      name: "효원공원 공중화장실",
      road_address: "경기도 수원시 팔달구 동수원로 397",
    });
    // 3) 동일 주소 중복 후보 -> 배치 내 중복 API 호출 0회
    const dupQueryCand = makeCandidate({
      id: "cand-dup-query",
      name: "공중화장실",
      road_address: "경기도 수원시 팔달구 효원로 255",
    });
    // 4) 일시 오류(네트워크 실패) -> memoryCache에 null 고정되지 않고 transientFailedIds로 추적되어 재시도 가능
    const transientCand = makeCandidate({
      id: "cand-transient",
      name: "임시 실패 공중화장실",
      road_address: "경기도 수원시 팔달구 인계로 199",
    });

    let transientAttempts = 0;
    const firstPass = await resolveViewportCandidatesWithKakao(
      [addrFirstCand, poiFirstCand, dupQueryCand, transientCand],
      {
        bounds: TEST_BOUNDS,
        officialRestrooms: [],
        sessionState,
        onResolvedItem: (item) => streamedIds.push(item.id),
        keywordSearchFn: async (q) => {
          callLog.push(`kw:${q}`);
          if (q.includes("효원공원")) {
            return [
              {
                name: "효원공원 공중화장실",
                roadAddress: "경기 수원시 팔달구 동수원로 397",
                jibunAddress: "",
                lat: 37.262,
                lng: 127.033,
              },
            ];
          }
          return [];
        },
        addressSearchFn: async (addr) => {
          callLog.push(`addr:${addr}`);
          if (addr.includes("199")) {
            transientAttempts += 1;
            if (transientAttempts === 1) {
              throw new Error("temporary network timeout");
            }
            return [
              {
                roadAddress: "경기 수원시 팔달구 인계로 199",
                jibunAddress: "",
                lat: 37.266,
                lng: 127.034,
              },
            ];
          }
          return [
            {
              roadAddress: "경기 수원시 팔달구 효원로 255",
              jibunAddress: "",
              lat: 37.264,
              lng: 127.031,
            },
          ];
        },
      }
    );

    expect(streamedIds).toContain("candidate:cand-addr-first");
    expect(streamedIds).toContain("candidate:cand-poi-first");
    // 효원로 255는 1회만 호출 (삼성애니텔은 address_first 1회, 공중화장실은 중복 공유로 0회)
    expect(callLog.filter((c) => c.startsWith("addr:") && c.includes("255"))).toHaveLength(1);
    expect(callLog.some((c) => c.startsWith("kw:") && c.includes("삼성애니텔"))).toBe(false);
    expect(callLog.some((c) => c.startsWith("addr:") && c.includes("397"))).toBe(false);
    expect(firstPass.transientFailedIds).toContain("cand-transient");
    expect(sessionState.memoryCache.has("cand-transient")).toBe(false);

    // 2차 재시도 시 일시 실패 후보는 정상 재조회되고 완료된 후보는 캐시 재사용(API 0회)
    const callsBeforeRetry = sessionState.callsUsed;
    const retryPass = await resolveViewportCandidatesWithKakao(
      [addrFirstCand, transientCand],
      {
        bounds: TEST_BOUNDS,
        officialRestrooms: [],
        sessionState,
        keywordSearchFn: async () => [],
        addressSearchFn: async (addr) => {
          if (addr.includes("199")) {
            return [
              {
                roadAddress: "경기 수원시 팔달구 인계로 199",
                jibunAddress: "",
                lat: 37.266,
                lng: 127.034,
              },
            ];
          }
          return [];
        },
      }
    );
    expect(retryPass.items.map((i) => i.id)).toEqual([
      "candidate:cand-addr-first",
      "candidate:cand-transient",
    ]);
    expect(sessionState.callsUsed - callsBeforeRetry).toBe(1);
  });
});

describe("MapDiscoveryClient '이 지역 재검색' 통합 및 비동기 race/오류 방어 (TASK 6·7)", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("/api/v1/events")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.startsWith("/api/v1/restrooms?")) {
        return new Response(
          JSON.stringify({
            ok: true,
            data: { items: [OFFICIAL_SUWON, OFFICIAL_PARTNER] },
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ ok: true, data: { items: [] } }), {
        status: 200,
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    cleanup();
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("초기 로딩에서는 공식 DB 핀만 즉시 표시하고, 빠른 이동 후 '이 지역에서 재검색' 시 오래된 응답을 무시하며 공식/참고 위치를 구분 표시한다", async () => {
    const harness = createTestMapProvider(TEST_BOUNDS);
    const candFetchCalls: number[] = [];

    const candidateFetchFn = vi.fn(async (bounds: MapBounds) => {
      const callNo = candFetchCalls.length + 1;
      candFetchCalls.push(callNo);
      if (callNo === 1) {
        // 1차 요청은 느리게 지연되어 2차 요청보다 늦게 도착 (순서 역전 시뮬레이션)
        await new Promise((r) => setTimeout(r, 80));
        return {
          items: [
            makeCandidate({
              id: "stale-1",
              name: "오래된 응답 화장실",
            }),
          ],
          regionCodes: ["41115"],
          regionNames: ["경기도 수원시 팔달구"],
          tooWide: false,
          totalReturned: 1,
        };
      }
      return {
        items: [
          makeCandidate({
            id: "fresh-2",
            name: "최신 인계공원 화장실",
            road_address: "경기도 수원시 팔달구 인계로 166",
          }),
        ],
        regionCodes: ["41115"],
        regionNames: ["경기도 수원시 팔달구"],
        tooWide: false,
        totalReturned: 1,
      };
    });

    const candidateResolveFn = vi.fn(async (items, options) => {
      return resolveViewportCandidatesWithKakao(items, {
        ...options,
        keywordSearchFn: async () => [],
        addressSearchFn: async (addr) => {
          if (addr.includes("인계로 166")) {
            return [
              {
                roadAddress: "경기도 수원시 팔달구 인계로 166",
                jibunAddress: "",
                lat: 37.265,
                lng: 127.033,
              },
            ];
          }
          return [
            {
              roadAddress: "경기도 수원시 팔달구 동수원로 397",
              jibunAddress: "",
              lat: 37.262,
              lng: 127.031,
            },
          ];
        },
      });
    });

    render(
      React.createElement(MapDiscoveryClient, {
        providerFactory: () => harness.provider,
        candidateFetchFn,
        candidateResolveFn,
      })
    );

    // 최초 로딩 직후 공식 DB 핀 2곳 표시 & 후보 자동 선조회 없음
    await waitFor(() => {
      expect(screen.getByText("이 지역 화장실 2곳")).toBeTruthy();
    });
    expect(candidateFetchFn).not.toHaveBeenCalled();

    // 지도 줌 아웃으로 '이 지역에서 재검색' 노출 후 1차 클릭
    act(() => {
      harness.setBounds({
        south: 37.255,
        west: 127.015,
        north: 37.275,
        east: 127.045,
      });
    });
    fireEvent.click(screen.getByTestId("map-zoom-out-btn"));
    fireEvent.click(screen.getByTestId("search-this-area-btn"));

    // 1차 요청 응답 전 빠르게 줌 인 + 2차 재검색 (비동기 역전 유발)
    act(() => {
      harness.setBounds({
        south: 37.256,
        west: 127.016,
        north: 37.276,
        east: 127.046,
      });
    });
    fireEvent.click(screen.getByTestId("map-zoom-in-btn"));
    fireEvent.click(screen.getByTestId("search-this-area-btn"));

    await waitFor(() => {
      expect(screen.getByText("이 지역 화장실 3곳")).toBeTruthy();
    });

    // 바텀시트 열어서 공식 vs 참고 위치 구분, 오래된 응답 무시, 제휴 화장실 보호 검증
    fireEvent.click(screen.getByTestId("bottom-sheet-toggle-btn"));

    expect(screen.queryByText("오래된 응답 화장실")).toBeNull();
    expect(screen.getByText("최신 인계공원 화장실")).toBeTruthy();
    expect(screen.getByText("수원시청 별관 화장실")).toBeTruthy();
    expect(screen.getByText("진미 통닭")).toBeTruthy();
    expect(screen.getByTestId("restroom-type-candidate-badge").textContent).toContain(
      "주소 기반 참고 위치"
    );
    expect(screen.getByTestId("detail-link-partner-jinmi-1")).toBeTruthy();
    // 후보 참고 위치에는 /restrooms/[id] 상세 페이지 링크가 생성되지 않음
    expect(screen.queryByTestId("detail-link-candidate:fresh-2")).toBeNull();

    // 참고 위치 길찾기 모달에서 주소 대표 지점 고지 확인
    fireEvent.click(screen.getByTestId("directions-btn-candidate:fresh-2"));
    expect(screen.getByTestId("directions-candidate-coord-notice").textContent).toContain(
      "주소 대표 지점 기반 참고 좌표"
    );
  });

  it("카카오 조회 실패(오류) 시에도 기존 공식 DB 화장실 지도는 정상 유지된다", async () => {
    const harness = createTestMapProvider(TEST_BOUNDS);
    const candidateFetchFn = vi.fn().mockRejectedValue(new Error("429 Too Many Requests"));

    render(
      React.createElement(MapDiscoveryClient, {
        providerFactory: () => harness.provider,
        candidateFetchFn,
      })
    );

    await waitFor(() => {
      expect(screen.getByText("이 지역 화장실 2곳")).toBeTruthy();
    });

    act(() => {
      harness.setBounds({
        south: 37.256,
        west: 127.016,
        north: 37.276,
        east: 127.046,
      });
    });
    fireEvent.click(screen.getByTestId("map-zoom-out-btn"));
    fireEvent.click(screen.getByTestId("search-this-area-btn"));

    await waitFor(() => {
      expect(candidateFetchFn).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByText("이 지역 화장실 2곳")).toBeTruthy();
    expect(screen.queryByTestId("api-error-banner")).toBeNull();
  });

  it("동일 영역 재검색 시 excludeIds/cursor를 전달하고 유효한 기존 참고 핀을 유지한 채 신규 핀을 점진 추가한다", async () => {
    const harness = createTestMapProvider(TEST_BOUNDS);
    const fetchOpts: Array<{ cursor?: string | null; excludeIds?: string[] } | undefined> = [];

    const candidateFetchFn = vi.fn(
      async (
        _bounds: MapBounds,
        _signal?: AbortSignal,
        opts?: { cursor?: string | null; excludeIds?: string[] }
      ) => {
        fetchOpts.push(opts);
        if (fetchOpts.length === 1) {
          return {
            items: [
              makeCandidate({
                id: "page1-cand",
                name: "1차 인계 화장실",
                road_address: "경기도 수원시 팔달구 효원로 270",
              }),
            ],
            regionCodes: ["41115"],
            regionNames: ["경기도 수원시 팔달구"],
            tooWide: false,
            totalReturned: 1,
            nextCursor: "o:1",
            hasMore: true,
          };
        }
        return {
          items: [
            makeCandidate({
              id: "page2-cand",
              name: "2차 매탄 화장실",
              road_address: "경기도 수원시 팔달구 인계로 190",
            }),
          ],
          regionCodes: ["41115"],
          regionNames: ["경기도 수원시 팔달구"],
          tooWide: false,
          totalReturned: 1,
          nextCursor: null,
          hasMore: false,
        };
      }
    );

    const candidateResolveFn = vi.fn(async (items, options) => {
      return resolveViewportCandidatesWithKakao(items, {
        ...options,
        keywordSearchFn: async () => [],
        addressSearchFn: async (addr) => {
          if (addr.includes("190")) {
            return [
              {
                roadAddress: "경기도 수원시 팔달구 인계로 190",
                jibunAddress: "",
                lat: 37.267,
                lng: 127.035,
              },
            ];
          }
          return [
            {
              roadAddress: "경기도 수원시 팔달구 효원로 270",
              jibunAddress: "",
              lat: 37.263,
              lng: 127.031,
            },
          ];
        },
      });
    });

    render(
      React.createElement(MapDiscoveryClient, {
        providerFactory: () => harness.provider,
        candidateFetchFn,
        candidateResolveFn,
      })
    );

    await waitFor(() => {
      expect(screen.getByText("이 지역 화장실 2곳")).toBeTruthy();
    });

    // 1차 재검색
    fireEvent.click(screen.getByTestId("map-zoom-out-btn"));
    fireEvent.click(screen.getByTestId("search-this-area-btn"));
    await waitFor(() => {
      expect(screen.getByText("이 지역 화장실 3곳")).toBeTruthy();
    });

    // 같은 영역에서 2차 재검색 (zoom-in 후 원래 bounds 유지 시나리오)
    fireEvent.click(screen.getByTestId("map-zoom-in-btn"));
    fireEvent.click(screen.getByTestId("search-this-area-btn"));

    await waitFor(() => {
      expect(screen.getByText("이 지역 화장실 4곳")).toBeTruthy();
    });
    expect(fetchOpts[1]?.cursor).toBe("o:1");
    expect(fetchOpts[1]?.excludeIds).toContain("page1-cand");
  });
});
