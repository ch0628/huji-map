import { describe, expect, it, vi, beforeAll, afterAll, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import {
  decodeCsvBuffer,
  importPublicRestrooms,
  createKakaoAddressGeocoder,
  evaluateKakaoDocument,
  normalizeProvinceToken,
  buildAddressQueryCandidates,
  assessExpectedRegionContext,
  DEFAULT_DAILY_GEOCODE_LIMIT,
  DEFAULT_MIN_DELAY_MS,
  DEFAULT_SUWON_SOURCE_CONFIG,
} from "@/lib/imports";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "hujimap-import-taskc-"));
}

/**
 * Real PGlite adapter supporting batch `.in()` and batch `.insert([...]).select(...)`
 * so `importPublicRestrooms` executes real SQL constraints, triggers, and batching.
 */
function createBatchPgliteAdapter(db: PGlite) {
  const insertedBatchSizes: number[] = [];

  return {
    insertedBatchSizes,
    from: vi.fn((table: string) => {
      if (table === "public_data_sources") {
        const filters: Record<string, any> = {};
        const chain: any = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn((col: string, val: any) => {
            filters[col] = val;
            return chain;
          }),
          maybeSingle: vi.fn(async () => {
            const res = await db.query(
              `SELECT id FROM public.public_data_sources WHERE provider_name = $1 AND dataset_name = $2 LIMIT 1`,
              [filters.provider_name, filters.dataset_name]
            );
            return { data: res.rows[0] ?? null, error: null };
          }),
          insert: vi.fn((row: any) => ({
            select: vi.fn(() => ({
              single: vi.fn(async () => {
                const res = await db.query(
                  `INSERT INTO public.public_data_sources (provider_name, dataset_name, source_url, api_endpoint, license_name, license_url, attribution_text)
                   VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
                  [
                    row.provider_name,
                    row.dataset_name,
                    row.source_url,
                    row.api_endpoint,
                    row.license_name,
                    row.license_url,
                    row.attribution_text,
                  ]
                );
                return { data: res.rows[0], error: null };
              }),
            })),
          })),
          update: vi.fn((patch: any) => ({
            eq: vi.fn(async (_col: string, val: string) => {
              await db.query(
                `UPDATE public.public_data_sources SET last_synced_at = $1 WHERE id = $2`,
                [patch.last_synced_at, val]
              );
              return { error: null };
            }),
          })),
        };
        return chain;
      }

      if (table === "public_import_runs") {
        return {
          insert: vi.fn((row: any) => ({
            select: vi.fn(() => ({
              single: vi.fn(async () => {
                const res = await db.query(
                  `INSERT INTO public.public_import_runs (source_id, started_at, status, fetched_count, inserted_count, updated_count, error_count)
                   VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
                  [
                    row.source_id,
                    row.started_at,
                    row.status,
                    row.fetched_count,
                    row.inserted_count,
                    row.updated_count,
                    row.error_count,
                  ]
                );
                return { data: res.rows[0], error: null };
              }),
            })),
          })),
          update: vi.fn((patch: any) => ({
            eq: vi.fn(async (_col: string, val: string) => {
              await db.query(
                `UPDATE public.public_import_runs
                 SET finished_at = $1, status = $2, fetched_count = $3, inserted_count = $4, updated_count = $5, error_count = $6, error_message = $7
                 WHERE id = $8`,
                [
                  patch.finished_at,
                  patch.status,
                  patch.fetched_count,
                  patch.inserted_count,
                  patch.updated_count,
                  patch.error_count,
                  patch.error_message,
                  val,
                ]
              );
              return { error: null };
            }),
          })),
        };
      }

      if (table === "restrooms") {
        let eqSourceId: string | null = null;
        const chain: any = {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn((col: string, val: any) => {
            if (col === "source_id") eqSourceId = val;
            return chain;
          }),
          in: vi.fn(async (col: string, vals: string[]) => {
            if (col !== "source_record_id" || vals.length === 0) {
              return { data: [], error: null };
            }
            const res = await db.query(
              `SELECT id, source_record_id, name, road_address, address_detail, latitude, longitude, gender_type, wheelchair_accessible, baby_changing_available, publication_status, approved_by
               FROM public.restrooms
               WHERE source_id = $1 AND source_record_id = ANY($2::text[])`,
              [eqSourceId, vals]
            );
            return { data: res.rows, error: null };
          }),
          insert: vi.fn((payload: any) => {
            const rows = Array.isArray(payload) ? payload : [payload];
            insertedBatchSizes.push(rows.length);

            const executeInsert = async () => {
              const inserted: any[] = [];
              for (const r of rows) {
                const res = await db.query(
                  `INSERT INTO public.restrooms (
                     type, business_id, source_id, source_record_id, name, description,
                     road_address, address_detail, latitude, longitude, gender_type,
                     wheelchair_accessible, baby_changing_available, sanitary_products_available,
                     access_method, publication_status, last_verified_at
                   ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
                   RETURNING id, source_record_id`,
                  [
                    r.type,
                    r.business_id,
                    r.source_id,
                    r.source_record_id,
                    r.name,
                    r.description,
                    r.road_address,
                    r.address_detail,
                    r.latitude,
                    r.longitude,
                    r.gender_type,
                    r.wheelchair_accessible,
                    r.baby_changing_available,
                    r.sanitary_products_available,
                    r.access_method,
                    r.publication_status,
                    r.last_verified_at,
                  ]
                );
                inserted.push(res.rows[0]);
              }
              return inserted;
            };

            return {
              select: vi.fn(() => {
                const promise = executeInsert()
                  .then((data) => ({ data, error: null }))
                  .catch((error: any) => ({ data: null, error }));
                return Object.assign(promise, {
                  single: vi.fn(async () => {
                    const res = await promise;
                    if (res.error || !res.data) {
                      return { data: null, error: res.error };
                    }
                    return { data: res.data[0], error: null };
                  }),
                });
              }),
            };
          }),
          update: vi.fn((patch: any) => ({
            eq: vi.fn(async (_col: string, id: string) => {
              try {
                await db.query(
                  `UPDATE public.restrooms
                   SET name = $1, description = $2, road_address = $3, address_detail = $4,
                       latitude = $5, longitude = $6, gender_type = $7,
                       wheelchair_accessible = $8, baby_changing_available = $9,
                       publication_status = $10, last_verified_at = $11
                   WHERE id = $12`,
                  [
                    patch.name,
                    patch.description,
                    patch.road_address,
                    patch.address_detail,
                    patch.latitude,
                    patch.longitude,
                    patch.gender_type,
                    patch.wheelchair_accessible,
                    patch.baby_changing_available,
                    patch.publication_status,
                    patch.last_verified_at,
                    id,
                  ]
                );
                return { error: null };
              } catch (error: any) {
                return { error };
              }
            }),
          })),
        };
        return chain;
      }

      if (table === "restroom_access_policies") {
        return {
          insert: vi.fn(async (payload: any) => {
            const rows = Array.isArray(payload) ? payload : [payload];
            try {
              for (const p of rows) {
                await db.query(
                  `INSERT INTO public.restroom_access_policies (restroom_id, version, access_mode, deposit_amount_krw, refund_eligible, is_active, effective_from)
                   VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                  [
                    p.restroom_id,
                    p.version,
                    p.access_mode,
                    p.deposit_amount_krw,
                    p.refund_eligible,
                    p.is_active,
                    p.effective_from,
                  ]
                );
              }
              return { error: null };
            } catch (error: any) {
              return { error };
            }
          }),
        };
      }

      throw new Error(`Unexpected table: ${table}`);
    }),
  } as any;
}

describe("TASK C — National 53,584 Restroom Collector Hardening", () => {
  const tempDirs: string[] = [];

  afterAll(() => {
    for (const d of tempDirs) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  // =========================================================================
  // 1. 전국 데이터 좌표 변환 준비 & 캐시 호환
  // =========================================================================
  describe("1. National Geocode Prep & Cache Compatibility", () => {
    it("전국 시·도 정규화 및 시·도 불일치 좌표 거부(별칭 허용)", () => {
      expect(normalizeProvinceToken("서울특별시 종로구 사직동")).toBe("서울");
      expect(normalizeProvinceToken("전라북도 전주시 완산구")).toBe("전북");
      expect(normalizeProvinceToken("전북특별자치도 전주시")).toBe("전북");
      expect(normalizeProvinceToken("경상북도 포항시 북구")).toBe("경북");

      // Valid match across alias (경상북도 == 경북)
      const ok = evaluateKakaoDocument(
        {
          address_type: "ROAD_ADDR",
          address_name: "경북 포항시 북구 중앙로 1",
          x: "129.365",
          y: "36.019",
          road_address: { region_1depth_name: "경북", address_name: "경북 포항시 북구 중앙로 1" },
        },
        null,
        "경상북도 포항시 북구 중앙로 1"
      );
      expect(ok.valid).toBe(true);

      // Cross-province mismatch rejected (서울특별시 vs 경기)
      const mismatch = evaluateKakaoDocument(
        {
          address_type: "ROAD_ADDR",
          address_name: "경기 성남시 분당구 판교로 1",
          x: "127.11",
          y: "37.40",
          road_address: { region_1depth_name: "경기", address_name: "경기 성남시 분당구 판교로 1" },
        },
        null,
        "서울특별시 강남구 테헤란로 1"
      );
      expect(mismatch.valid).toBe(false);
    });

    it("시·도 검증 우회 방지, 개편 행정구역(전남광주통합·인천영종구), 오타·띄어쓰기 정규화 및 더미 제외를 검증한다", async () => {
      // 1. 전남광주통합특별시: 전남/광주/전남광주통합 모두 허용, 타 시·도는 거부
      expect(normalizeProvinceToken("전남광주통합특별시 목포시 남악로 19")).toBe("전남광주통합");
      expect(normalizeProvinceToken("전남광주통합특별시해남군 화원면 청용리 479")).toBe("전남광주통합");

      const jeonnamRes = evaluateKakaoDocument(
        {
          address_type: "ROAD_ADDR",
          address_name: "전남 목포시 남악로 19",
          x: "126.4414",
          y: "34.8036",
          road_address: { region_1depth_name: "전남", region_2depth_name: "목포시", address_name: "전남 목포시 남악로 19" },
        },
        null,
        { roadAddress: "전남광주통합특별시 목포시 남악로 19", jibunAddress: "", agency: "목포시" }
      );
      expect(jeonnamRes.valid).toBe(true);

      const gwangjuRes = evaluateKakaoDocument(
        {
          address_type: "ROAD_ADDR",
          address_name: "광주 동구 갈마로 68",
          x: "126.9379",
          y: "35.1615",
          road_address: { region_1depth_name: "광주", region_2depth_name: "동구", address_name: "광주 동구 갈마로 68" },
        },
        null,
        { roadAddress: "전남광주통합특별시 동구 갈마로 68", jibunAddress: "", agency: "광주광역시 동구" }
      );
      expect(gwangjuRes.valid).toBe(true);

      const wrongProvinceForIntegrated = evaluateKakaoDocument(
        {
          address_type: "ROAD_ADDR",
          address_name: "전북 전주시 완산구 기린대로 1",
          x: "127.14",
          y: "35.82",
          road_address: { region_1depth_name: "전북", region_2depth_name: "전주시 완산구", address_name: "전북 전주시 완산구 기린대로 1" },
        },
        null,
        { roadAddress: "전남광주통합특별시 목포시 남악로 19" }
      );
      expect(wrongProvinceForIntegrated.valid).toBe(false);

      // 2. 인천 영종구/서해구 등 실제 개편 행정구역 정상 허용
      const yeongjongRes = evaluateKakaoDocument(
        {
          address_type: "ROAD_ADDR",
          address_name: "인천 영종구 대무의로 26-9",
          x: "126.4134",
          y: "37.4092",
          road_address: { region_1depth_name: "인천", region_2depth_name: "영종구", address_name: "인천 영종구 대무의로 26-9" },
        },
        null,
        { roadAddress: "인천광역시 중구 대무의로 26-9" }
      );
      expect(yeongjongRes.valid).toBe(true);

      // 3. 띄어쓰기 오류 및 시·도 오타 정규화
      expect(normalizeProvinceToken("서울특별시중랑구 동일로129길 1")).toBe("서울");
      expect(normalizeProvinceToken("부산광역 시 동구 구청로 1")).toBe("부산");
      expect(normalizeProvinceToken("서을특별시 광진구 용마도시자연공원")).toBe("서울");
      expect(normalizeProvinceToken("경상붓도 봉화군 소천면 고선리 산5-1")).toBe("경북");
      expect(normalizeProvinceToken("경상북 봉화군 봉성면 시거리길267-235")).toBe("경북");
      expect(normalizeProvinceToken("경상님도 양산시 황산로 719")).toBe("경남");

      const typoMismatch = evaluateKakaoDocument(
        {
          address_type: "ROAD_ADDR",
          address_name: "경기 구리시 아차산로 1",
          x: "127.12",
          y: "37.58",
          road_address: { region_1depth_name: "경기", region_2depth_name: "구리시", address_name: "경기 구리시 아차산로 1" },
        },
        null,
        "서을특별시 광진구 용마도시자연공원"
      );
      expect(typoMismatch.valid).toBe(false);

      // 4. 더미 주소("없음", "부여불가") 검색 후보 제외
      expect(buildAddressQueryCandidates("없음", "서울특별시 성북구 성북동 168-274")).toEqual([
        "서울특별시 성북구 성북동 168-274",
      ]);
      expect(buildAddressQueryCandidates("부여불가", "경상북도 상주시 중동면 오상리 968-1번지")).toEqual([
        "경상북도 상주시 중동면 오상리 968-1번지",
      ]);
      expect(buildAddressQueryCandidates("없음", "부여불가")).toEqual([]);

      // 5. 무힌트/동명구 모호 주소는 evaluateKakaoDocument 및 geocoder에서 uncertain으로 차단
      const unanchoredDocCheck = evaluateKakaoDocument(
        {
          address_type: "ROAD_ADDR",
          address_name: "인천 남동구 서창로 194",
          x: "126.74",
          y: "37.43",
          road_address: { region_1depth_name: "인천", region_2depth_name: "남동구", address_name: "인천 남동구 서창로 194" },
        },
        null,
        { roadAddress: "서창로 194 (서창동주민센터)", jibunAddress: "", agency: "서창동주민센터" }
      );
      expect(unanchoredDocCheck.valid).toBe(false);

      const ambiguousGuAssessment = assessExpectedRegionContext({
        roadAddress: "동구 중앙로 1",
        jibunAddress: "",
        agency: "동구청",
      });
      expect(ambiguousGuAssessment.valid).toBe(false);

      // 6. 시·도 생략 주소의 관리기관 교차 검증 및 충돌 시 uncertain 차단
      const fetchMock = vi.fn(async (url: string) => {
        const q = decodeURIComponent(new URL(url).searchParams.get("query") || "");
        if (q.includes("남면 신남리 454")) {
          // Simulates wrong-region first result + correct second result, or wrong-only result
          return {
            ok: true,
            status: 200,
            json: async () => ({
              documents: [
                {
                  address_type: "REGION_ADDR",
                  address_name: "충남 태안군 남면 신남리 454",
                  x: "126.31",
                  y: "36.65",
                  address: { region_1depth_name: "충남", region_2depth_name: "태안군", address_name: "충남 태안군 남면 신남리 454" },
                },
              ],
            }),
          };
        }
        if (q.includes("성북동 168-274")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              documents: [
                {
                  address_type: "REGION_ADDR",
                  address_name: "서울 성북구 성북동 168-274",
                  x: "127.00",
                  y: "37.59",
                  address: { region_1depth_name: "서울", region_2depth_name: "성북구", address_name: "서울 성북구 성북동 168-274" },
                },
              ],
            }),
          };
        }
        if (q.includes("청량리동 207-71")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              documents: [
                {
                  address_type: "REGION_ADDR",
                  address_name: "서울 동대문구 청량리동 207-71",
                  x: "127.04",
                  y: "37.58",
                  address: { region_1depth_name: "서울", region_2depth_name: "동대문구", address_name: "서울 동대문구 청량리동 207-71" },
                },
              ],
            }),
          };
        }
        return { ok: true, status: 200, json: async () => ({ documents: [] }) };
      });

      const geo = createKakaoAddressGeocoder({
        apiKey: "test-key",
        minDelayMs: 0,
        fetchImpl: fetchMock as any,
      });

      // (a) agency=인제군청 vs Kakao 충남 태안군 -> uncertain!
      const wrongAgencyMatch = await geo({
        roadAddress: "",
        jibunAddress: "남면 신남리 454",
        agency: "인제군청 환경보호과",
      });
      expect(wrongAgencyMatch.status).toBe("uncertain");

      // (b) 무힌트 주소는 HTTP 호출 없이 uncertain
      const callsBefore = fetchMock.mock.calls.length;
      const unanchoredRes = await geo({
        roadAddress: "서창로 194 (서창동주민센터)",
        jibunAddress: "",
        agency: "서창동주민센터",
      });
      expect(unanchoredRes.status).toBe("uncertain");
      expect(fetchMock.mock.calls.length).toBe(callsBefore);

      // (c) 도로명/지번 시·도 충돌 -> HTTP 호출 없이 uncertain
      const conflictingSource = await geo({
        roadAddress: "서울특별시 종로구 사직로 1",
        jibunAddress: "부산광역시 해운대구 우동 1",
        agency: "",
      });
      expect(conflictingSource.status).toBe("uncertain");
      expect(fetchMock.mock.calls.length).toBe(callsBefore);

      // (d) 더미 "없음" 건너뛰고 지번주소로 1회만에 성공 + 인접 관리기관(성북구청)과 물리 지번(동대문구) 공존 시 물리 주소 우선 성공
      const dummySkipped = await geo({
        roadAddress: "없음",
        jibunAddress: "서울특별시 성북구 성북동 168-274",
        agency: "성북구청 공원녹지과",
      });
      expect(dummySkipped.status).toBe("success");
      expect(dummySkipped.queryUsed).toBe("서울특별시 성북구 성북동 168-274");

      const borderAgencyAllowed = await geo({
        roadAddress: "없음",
        jibunAddress: "서울특별시 동대문구 청량리동 207-71",
        agency: "성북구청 청소행정과",
      });
      expect(borderAgencyAllowed.status).toBe("success");
    });

    it("기존 '수원시::...' 캐시를 전국 모드(cityFilter=null)에서 HTTP 호출 없이 재사용한다", async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      const cachePath = path.join(dir, "cache.json");
      fs.writeFileSync(
        cachePath,
        JSON.stringify({
          "수원시::경기도 수원시 팔달구 정조로 833": {
            status: "success",
            latitude: 37.2827,
            longitude: 127.0158,
            matchedAddress: "경기 수원시 팔달구 정조로 833",
            addressType: "ROAD_ADDR",
            queryUsed: "경기도 수원시 팔달구 정조로 833",
          },
        }),
        "utf8"
      );

      const fetchMock = vi.fn();
      const geocoder = createKakaoAddressGeocoder({
        apiKey: "test-rest-key",
        cachePath,
        fetchImpl: fetchMock as any,
      });

      const res = await geocoder({
        roadAddress: "경기도 수원시 팔달구 정조로 833",
        jibunAddress: "",
        cityFilter: null,
      });

      expect(res.status).toBe("success");
      expect(res.latitude).toBeCloseTo(37.2827);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(geocoder.getStats?.().cacheHits).toBe(1);
    });

    it("실제 local-data/public_restroom_raw.csv 53,584건 dry-run 파싱(카카오 API 0건)", async () => {
      const rawCsvPath = path.resolve(process.cwd(), "local-data/public_restroom_raw.csv");
      if (!fs.existsSync(rawCsvPath)) return;

      const csvText = decodeCsvBuffer(fs.readFileSync(rawCsvPath), "auto");
      const mockDb = { from: vi.fn() } as any;
      const res = await importPublicRestrooms(mockDb, csvText, {
        dryRun: true,
        cityFilter: null,
        skipUnlocatedNew: true,
        batchSize: 500,
      });

      expect(res.status).toBe("success");
      expect(res.fetchedCount).toBe(53584);
      expect(res.totalValidRecords).toBe(53584);
      expect(res.duplicateCount).toBe(0);
      expect(res.errorCount).toBe(0);
      expect(res.skippedUnlocatedNewCount).toBe(53584);
      expect(res.insertedCount).toBe(0);
    }, 30000);
  });

  // =========================================================================
  // 2. 카카오 API 호출량 제한, QPS 제어 및 429/401 중단
  // =========================================================================
  describe("2. Kakao API Quota, Usage Persistence & Rate Limiting", () => {
    it("기본 일일 상한(30,000)과 최소 간격(100ms)을 사용하고, maxCallsPerRun 초과 시 즉시 중단한다", async () => {
      expect(DEFAULT_DAILY_GEOCODE_LIMIT).toBe(30000);
      expect(DEFAULT_MIN_DELAY_MS).toBe(100);

      const dir = makeTempDir();
      tempDirs.push(dir);
      const usagePath = path.join(dir, "usage.json");
      const cachePath = path.join(dir, "cache.json");

      const callTimestamps: number[] = [];
      const fetchMock = vi.fn(async (url: string) => {
        callTimestamps.push(Date.now());
        const q = decodeURIComponent(new URL(url).searchParams.get("query") || "");
        const depth1 = q.startsWith("부산") ? "부산" : q.startsWith("대구") ? "대구" : "서울";
        return {
          ok: true,
          status: 200,
          json: async () => ({
            documents: [
              {
                address_type: "ROAD_ADDR",
                address_name: q,
                x: "127.0",
                y: "37.0",
                road_address: { region_1depth_name: depth1, address_name: q },
              },
            ],
          }),
        };
      });

      const geocoder = createKakaoAddressGeocoder({
        apiKey: "test-key",
        cachePath,
        usagePath,
        maxCallsPerRun: 2,
        minDelayMs: 50,
        fetchImpl: fetchMock as any,
        nowFn: () => new Date("2026-11-19T12:00:00Z"),
      });

      const r1 = await geocoder({ roadAddress: "서울특별시 중구 세종대로 110", jibunAddress: "" });
      const r2 = await geocoder({ roadAddress: "서울특별시 종로구 사직로 161", jibunAddress: "" });
      const r3 = await geocoder({ roadAddress: "부산광역시 해운대구 해운대해변로 264", jibunAddress: "" });

      expect(r1.status).toBe("success");
      expect(r2.status).toBe("success");
      expect(r3.status).toBe("error");
      expect(r3.fatalStopReason).toBe("quota_exceeded");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(callTimestamps[1] - callTimestamps[0]).toBeGreaterThanOrEqual(40);

      geocoder.flushUsage?.();
      geocoder.flushCache?.();

      // Re-instantiate next run on same KST day (22:00 KST): daily count (2) is persisted!
      const geocoder2 = createKakaoAddressGeocoder({
        apiKey: "test-key",
        cachePath,
        usagePath,
        dailyLimit: 3,
        minDelayMs: 0,
        fetchImpl: fetchMock as any,
        nowFn: () => new Date("2026-11-19T13:00:00Z"),
      });
      expect(geocoder2.getStats?.().todayHttpCalls).toBe(2);
      expect(geocoder2.getStats?.().remainingDailyQuota).toBe(1);

      const r4 = await geocoder2({ roadAddress: "부산광역시 해운대구 해운대해변로 264", jibunAddress: "" });
      const r5 = await geocoder2({ roadAddress: "대구광역시 중구 공평로 88", jibunAddress: "" });
      expect(r4.status).toBe("success");
      expect(r5.fatalStopReason).toBe("quota_exceeded");

      geocoder2.flushUsage?.();

      // Next KST day (2026-11-20 00:00 KST = 2026-11-19T15:00:00Z): daily quota resets!
      const geocoderNextDay = createKakaoAddressGeocoder({
        apiKey: "test-key",
        cachePath,
        usagePath,
        dailyLimit: 3,
        minDelayMs: 0,
        fetchImpl: fetchMock as any,
        nowFn: () => new Date("2026-11-19T15:00:00Z"),
      });
      expect(geocoderNextDay.getStats?.().todayHttpCalls).toBe(0);
      expect(geocoderNextDay.getStats?.().remainingDailyQuota).toBe(3);
    });

    it("HTTP 429 또는 401 수신 시 캐시를 보존하고 즉시 중단 신호를 반환한다", async () => {
      const fetch429 = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) }));
      const geo429 = createKakaoAddressGeocoder({
        apiKey: "test-key",
        minDelayMs: 0,
        retryDelayMs: 0,
        fetchImpl: fetch429 as any,
      });

      const res429 = await geo429({ roadAddress: "서울특별시 강남구 테헤란로 1", jibunAddress: "" });
      expect(res429.status).toBe("error");
      expect(res429.fatalStopReason).toBe("rate_limited");
      expect(fetch429).toHaveBeenCalledTimes(2); // 1 initial + 1 retry

      const fetch401 = vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) }));
      const geo401 = createKakaoAddressGeocoder({
        apiKey: "bad-key",
        minDelayMs: 0,
        retryDelayMs: 0,
        fetchImpl: fetch401 as any,
      });

      const res401 = await geo401({ roadAddress: "서울특별시 강남구 테헤란로 1", jibunAddress: "" });
      expect(res401.status).toBe("error");
      expect(res401.fatalStopReason).toBe("auth_error");
      expect(fetch401).toHaveBeenCalledTimes(1); // immediate stop on auth error
    });

    it("JS 키 폴백 없이 KAKAO_REST_API_KEY를 필수로 요구하며, 동시/재시도 호출에서도 maxCallsPerRun 상한을 엄격히 준수한다", async () => {
      const prevRest = process.env.KAKAO_REST_API_KEY;
      const prevJs = process.env.NEXT_PUBLIC_KAKAO_MAP_JS_KEY;
      try {
        delete process.env.KAKAO_REST_API_KEY;
        process.env.NEXT_PUBLIC_KAKAO_MAP_JS_KEY = "js-only-key-should-not-be-used";
        expect(() => createKakaoAddressGeocoder()).toThrow(/KAKAO_REST_API_KEY/);
      } finally {
        if (prevRest !== undefined) process.env.KAKAO_REST_API_KEY = prevRest;
        else delete process.env.KAKAO_REST_API_KEY;
        if (prevJs !== undefined) process.env.NEXT_PUBLIC_KAKAO_MAP_JS_KEY = prevJs;
        else delete process.env.NEXT_PUBLIC_KAKAO_MAP_JS_KEY;
      }

      // Even under concurrent calls + 500 retries, total HTTP calls must never exceed maxCallsPerRun
      const fetchRetry = vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({}),
      }));
      const geo = createKakaoAddressGeocoder({
        apiKey: "test-rest-key",
        maxCallsPerRun: 3,
        minDelayMs: 5,
        retryDelayMs: 0,
        fetchImpl: fetchRetry as any,
      });

      await Promise.all([
        geo({ roadAddress: "서울특별시 중구 세종대로 1", jibunAddress: "" }),
        geo({ roadAddress: "서울특별시 중구 세종대로 2", jibunAddress: "" }),
        geo({ roadAddress: "서울특별시 중구 세종대로 3", jibunAddress: "" }),
        geo({ roadAddress: "서울특별시 중구 세종대로 4", jibunAddress: "" }),
      ]);

      expect(fetchRetry).toHaveBeenCalledTimes(3);
      expect(geo.getStats?.().runHttpCalls).toBe(3);
    });
  });

  // =========================================================================
  // 3~6. PGlite 배치 저장, 중복 방지, 중단 후 이어하기, 기존 데이터/상태 보존
  // =========================================================================
  describe("3~6. PGlite Batch Save, Resume, Deduplication & State Preservation", () => {
    let db: PGlite;
    let sourceId: string;
    let adminUserId: string;
    let approvedPartnerRestroomId: string;

    beforeAll(async () => {
      db = new PGlite();
      await db.exec(`
        CREATE SCHEMA IF NOT EXISTS auth;
        CREATE TABLE IF NOT EXISTS auth.users (
          id uuid PRIMARY KEY,
          email text UNIQUE,
          raw_user_meta_data jsonb DEFAULT '{}'::jsonb,
          created_at timestamptz DEFAULT now(),
          updated_at timestamptz DEFAULT now()
        );
        CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
          SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
        $$;
        CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
          SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), current_setting('role', true), 'anon');
        $$;
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
          IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_auth_admin') THEN CREATE ROLE supabase_auth_admin; END IF;
        END $$;
        GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
        GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO anon, authenticated, service_role;
      `);

      const ROOT = process.cwd();
      for (const m of [
        "20261106000000_auth_schema.sql",
        "20261107000000_lead_tracking.sql",
        "20261108000000_business_backend.sql",
        "20261109000000_audit_and_approval.sql",
        "20261110000000_restroom_schema.sql",
      ]) {
        await db.exec(fs.readFileSync(path.join(ROOT, "supabase/migrations", m), "utf8"));
      }
    }, 30000);

    beforeEach(async () => {
      await db.exec(`
        TRUNCATE public.restroom_access_policies, public.restrooms, public.public_import_runs, public.public_data_sources, public.businesses, public.profiles, auth.users CASCADE;
      `);

      adminUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const bizId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      approvedPartnerRestroomId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

      await db.query(`INSERT INTO auth.users (id, email) VALUES ($1, 'admin@test.local')`, [adminUserId]);
      await db.query(
        `INSERT INTO public.businesses (id, name, category, road_address, latitude, longitude, registration_status, created_by, approved_by, approved_at)
         VALUES ($1, '테스트 제휴 카페', '카페', '경기도 수원시 팔달구 정조로 10', 37.28, 127.01, 'approved', $2, $2, now())`,
        [bizId, adminUserId]
      );
      await db.query(
        `INSERT INTO public.restrooms (id, business_id, type, name, road_address, latitude, longitude, access_method, publication_status, approved_by)
         VALUES ($1, $2, 'partner', '제휴 화장실(보존대상)', '경기도 수원시 팔달구 정조로 10', 37.28, 127.01, 'pin', 'published', $3)`,
        [approvedPartnerRestroomId, bizId, adminUserId]
      );

      const srcRes: any = await db.query(
        `INSERT INTO public.public_data_sources (provider_name, dataset_name, source_url)
         VALUES ($1, $2, $3) RETURNING id`,
        [
          DEFAULT_SUWON_SOURCE_CONFIG.providerName,
          DEFAULT_SUWON_SOURCE_CONFIG.datasetName,
          DEFAULT_SUWON_SOURCE_CONFIG.sourceUrl,
        ]
      );
      sourceId = srcRes.rows[0].id;

      // Seed existing published (with approved_by), archived, and suspended public restrooms
      await db.query(
        `INSERT INTO public.restrooms (source_id, source_record_id, type, name, road_address, latitude, longitude, wheelchair_accessible, publication_status, approved_by)
         VALUES
           ($1, 'EXIST-PUB', 'public', '기존 공개 화장실', '경기도 수원시 팔달구 매산로 1', 37.266, 127.001, false, 'published', $2),
           ($1, 'EXIST-ARCH', 'public', '기존 폐쇄 화장실', '경기도 수원시 팔달구 매산로 2', 37.267, 127.002, false, 'archived', $2),
           ($1, 'EXIST-SUSP', 'public', '기존 정지 화장실', '경기도 수원시 팔달구 매산로 3', 37.268, 127.003, false, 'suspended', $2)`,
        [sourceId, adminUserId]
      );
    });

    afterAll(async () => {
      if (db) await db.close();
    });

    it("배치 2건씩 나눠 저장하고 할당량 중단(--max-calls) 후 --resume으로 중복 없이 이어서 완료한다", async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      const cachePath = path.join(dir, "cache.json");
      const usagePath = path.join(dir, "usage.json");
      const checkpointPath = path.join(dir, "checkpoint.json");

      const csv = [
        "관리번호,화장실명,소재지도로명주소",
        "NAT-1,서울 사직 화장실,서울특별시 종로구 사직로 1",
        "NAT-2,부산 해운대 화장실,부산광역시 해운대구 해운대해변로 2",
        "NAT-3,미검출 신규 화장실,강원특별자치도 춘천시 없는길 999",
        "NAT-4,대구 동성로 화장실,대구광역시 중구 동성로 3",
        "NAT-5,광주 충장로 화장실,광주광역시 동구 충장로 4",
      ].join("\n");

      const mockFetch = vi.fn(async (url: string) => {
        const q = decodeURIComponent(new URL(url).searchParams.get("query") || "");
        if (q.includes("없는길")) {
          return { ok: true, status: 200, json: async () => ({ documents: [] }) };
        }
        const coords: Record<string, [string, string, string]> = {
          사직로: ["126.97", "37.57", "서울"],
          해운대: ["129.16", "35.16", "부산"],
          동성로: ["128.59", "35.87", "대구"],
          충장로: ["126.91", "35.15", "광주"],
        };
        const match = Object.entries(coords).find(([k]) => q.includes(k));
        return {
          ok: true,
          status: 200,
          json: async () => ({
            documents: match
              ? [
                  {
                    address_type: "ROAD_ADDR",
                    address_name: q,
                    x: match[1][0],
                    y: match[1][1],
                    road_address: { region_1depth_name: match[1][2], address_name: q },
                  },
                ]
              : [],
          }),
        };
      });

      const adapter = createBatchPgliteAdapter(db);

      // Run 1: cap at 2 HTTP calls -> NAT-1, NAT-2 succeed & batch 1 commits; NAT-3 hits quota_exceeded!
      const geo1 = createKakaoAddressGeocoder({
        apiKey: "test-key",
        cachePath,
        usagePath,
        maxCallsPerRun: 2,
        minDelayMs: 0,
        fetchImpl: mockFetch as any,
        nowFn: () => new Date("2026-11-19T12:00:00Z"),
      });

      const run1 = await importPublicRestrooms(adapter, csv, {
        dryRun: false,
        cityFilter: null,
        batchSize: 2,
        skipUnlocatedNew: true,
        checkpointPath,
        geocoder: geo1,
      });

      expect(run1.status).toBe("paused");
      expect(run1.stoppedReason).toBe("quota_exceeded");
      expect(run1.insertedCount).toBe(2); // NAT-1, NAT-2 saved in batch 1
      expect(run1.nextIndex).toBe(2); // paused right at NAT-3
      expect(adapter.insertedBatchSizes).toEqual([2]);

      const cpAfterRun1 = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
      expect(cpAfterRun1.status).toBe("paused");
      expect(cpAfterRun1.nextIndex).toBe(2);

      // Run 2: resume from checkpoint with higher run limit -> finishes NAT-3(unlocated skip), NAT-4, NAT-5
      const geo2 = createKakaoAddressGeocoder({
        apiKey: "test-key",
        cachePath,
        usagePath,
        maxCallsPerRun: 10,
        minDelayMs: 0,
        fetchImpl: mockFetch as any,
        nowFn: () => new Date("2026-11-19T13:00:00Z"),
      });

      const run2 = await importPublicRestrooms(adapter, csv, {
        dryRun: false,
        cityFilter: null,
        batchSize: 2,
        skipUnlocatedNew: true,
        checkpointPath,
        resume: true,
        geocoder: geo2,
      });

      expect(run2.status).toBe("success");
      expect(run2.resumedFromIndex).toBe(2);
      expect(run2.nextIndex).toBe(5);
      expect(run2.insertedCount).toBe(2); // NAT-4, NAT-5 (NAT-3 skipped because skipUnlocatedNew=true)
      expect(run2.skippedUnlocatedNewCount).toBe(1);

      // Verify DB rows: 3 seeded public + 1 partner + 4 new national (NAT-1,2,4,5), 0 NAT-3, 0 duplicates
      const dbCount: any = await db.query(
        `SELECT source_record_id, publication_status FROM public.restrooms WHERE type = 'public' ORDER BY source_record_id`
      );
      const ids = dbCount.rows.map((r: any) => r.source_record_id);
      expect(ids).toEqual([
        "EXIST-ARCH",
        "EXIST-PUB",
        "EXIST-SUSP",
        "NAT-1",
        "NAT-2",
        "NAT-4",
        "NAT-5",
      ]);

      // Verify free policies created for all 4 newly inserted restrooms
      const polRes: any = await db.query(`SELECT COUNT(*)::int AS cnt FROM public.restroom_access_policies`);
      expect(polRes.rows[0].cnt).toBe(4);

      // Run 3: re-run entire file without geocoder -> existing DB coords preserved, 0 API calls, 0 duplicates!
      const run3 = await importPublicRestrooms(adapter, csv, {
        dryRun: false,
        cityFilter: null,
        batchSize: 2,
        skipUnlocatedNew: true,
      });
      expect(run3.status).toBe("success");
      expect(run3.insertedCount).toBe(0);
      expect(run3.updatedCount).toBe(0);
      expect(run3.skippedCount).toBe(4);
      expect(run3.preservedExistingCount).toBe(4);
      expect(run3.skippedUnlocatedNewCount).toBe(1);
    });

    it("기존 공개·승인·비공개(archived/suspended) 및 제휴 화장실 상태·좌표를 보존하고 미변환 신규 건은 저장하지 않는다", async () => {
      const csv = [
        "관리번호,화장실명,소재지도로명주소",
        "EXIST-PUB,기존 공개 화장실(이름수정),경기도 수원시 팔달구 매산로 1",
        "EXIST-ARCH,기존 폐쇄 화장실,경기도 수원시 팔달구 매산로 2",
        "EXIST-SUSP,기존 정지 화장실,경기도 수원시 팔달구 매산로 3",
        "NEW-UNLOCATED,신규 좌표없음 화장실,서울특별시 종로구 어딘가 1",
      ].join("\n");

      const adapter = createBatchPgliteAdapter(db);
      const res = await importPublicRestrooms(adapter, csv, {
        dryRun: false,
        cityFilter: null,
        batchSize: 500,
        skipUnlocatedNew: true,
        preserveAdminStatus: true,
      });

      expect(res.status).toBe("success");
      expect(res.insertedCount).toBe(0); // NEW-UNLOCATED not inserted
      expect(res.skippedUnlocatedNewCount).toBe(1);
      expect(res.updatedCount).toBe(1); // EXIST-PUB name updated
      expect(res.skippedCount).toBe(2); // EXIST-ARCH, EXIST-SUSP unchanged
      expect(res.preservedExistingCount).toBe(3);

      const rowsRes: any = await db.query(
        `SELECT id, type, source_record_id, name, latitude, longitude, publication_status, approved_by
         FROM public.restrooms
         ORDER BY type, source_record_id`
      );

      const partner = rowsRes.rows.find((r: any) => r.type === "partner");
      expect(partner?.id).toBe(approvedPartnerRestroomId);
      expect(partner?.publication_status).toBe("published");

      const pub = rowsRes.rows.find((r: any) => r.source_record_id === "EXIST-PUB");
      expect(pub?.name).toBe("기존 공개 화장실(이름수정)");
      expect(pub?.latitude).toBeCloseTo(37.266);
      expect(pub?.longitude).toBeCloseTo(127.001);
      expect(pub?.publication_status).toBe("published");
      expect(pub?.approved_by).toBe(adminUserId);

      const arch = rowsRes.rows.find((r: any) => r.source_record_id === "EXIST-ARCH");
      expect(arch?.publication_status).toBe("archived");

      const susp = rowsRes.rows.find((r: any) => r.source_record_id === "EXIST-SUSP");
      expect(susp?.publication_status).toBe("suspended");

      const newUnlocated = rowsRes.rows.find((r: any) => r.source_record_id === "NEW-UNLOCATED");
      expect(newUnlocated).toBeUndefined();
    });

    it("다른 파일 또는 다른 cityFilter로 --resume 시도 시 안전하게 차단한다", async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      const checkpointPath = path.join(dir, "cp.json");

      const csv1 = "관리번호,화장실명,소재지도로명주소,WGS84위도,WGS84경도\nA-1,화장실A,서울시 중구 1,37.56,126.97";
      const csv2 = "관리번호,화장실명,소재지도로명주소,WGS84위도,WGS84경도\nB-1,화장실B,부산시 중구 1,35.10,129.03";

      const adapter = createBatchPgliteAdapter(db);
      await importPublicRestrooms(adapter, csv1, {
        dryRun: true,
        cityFilter: null,
        checkpointPath,
      });

      const mismatched = await importPublicRestrooms(adapter, csv2, {
        dryRun: true,
        cityFilter: null,
        checkpointPath,
        resume: true,
      });
      expect(mismatched.status).toBe("failed");
      expect(mismatched.errorMessage).toContain("체크포인트");
    });

    it("AbortSignal 중단 신호 수신 시 현재 지점까지만 저장하고 interrupted 상태로 종료한다", async () => {
      const dir = makeTempDir();
      tempDirs.push(dir);
      const checkpointPath = path.join(dir, "cp-abort.json");
      const csv = [
        "관리번호,화장실명,소재지도로명주소",
        "AB-1,화장실1,서울특별시 종로구 사직로 1",
        "AB-2,화장실2,서울특별시 종로구 사직로 2",
      ].join("\n");

      const controller = new AbortController();
      const adapter = createBatchPgliteAdapter(db);
      const geo = createKakaoAddressGeocoder({
        apiKey: "test-key",
        minDelayMs: 0,
        fetchImpl: vi.fn(async (url: string) => {
          const q = decodeURIComponent(new URL(url).searchParams.get("query") || "");
          if (q.includes("사직로 1")) {
            controller.abort(); // interrupt right after first geocode!
          }
          return {
            ok: true,
            status: 200,
            json: async () => ({
              documents: [
                {
                  address_type: "ROAD_ADDR",
                  address_name: q,
                  x: "126.97",
                  y: "37.57",
                  road_address: { region_1depth_name: "서울", address_name: q },
                },
              ],
            }),
          };
        }) as any,
      });

      const res = await importPublicRestrooms(adapter, csv, {
        dryRun: false,
        cityFilter: null,
        batchSize: 10,
        checkpointPath,
        geocoder: geo,
        signal: controller.signal,
      });

      expect(res.status).toBe("paused");
      expect(res.stoppedReason).toBe("interrupted");
      expect(res.insertedCount).toBe(1);
      expect(res.nextIndex).toBe(1);

      const cp = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
      expect(cp.status).toBe("interrupted");
      expect(cp.nextIndex).toBe(1);
    });

    it("신규 예외 주소 교차 검증: 정상·개편·오타보정·관리기관일치 건만 적재하고 불확실(uncertain)·오변환 건은 DB 등록을 차단한다", async () => {
      const csv = [
        "관리번호,화장실명,소재지도로명주소,소재지지번주소,관리기관명",
        "REG-OK-1,목포 현충공원,전남광주통합특별시 목포시 남악로 19,,목포시",
        "REG-OK-2,인제 남면 소공원,,남면 신남리 454,인제군청 환경보호과",
        "REG-OK-3,상주 축구장,부여불가,경상북도 상주시 중동면 오상리 968-1번지,새마을체육과",
        "REG-OK-4,광진구 토요마당,서을특별시 광진구 용마도시자연공원,,광진구 청소과",
        "REG-UNCERTAIN-1,무힌트 서창동,서창로 194 (서창동주민센터),,서창동주민센터",
        "REG-UNCERTAIN-2,타지역 오변환 차단,,남면 신남리 999,인제군청 환경보호과",
      ].join("\n");

      const mockFetch = vi.fn(async (url: string) => {
        const q = decodeURIComponent(new URL(url).searchParams.get("query") || "");
        if (q.includes("목포시 남악로 19")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              documents: [
                {
                  address_type: "ROAD_ADDR",
                  address_name: "전남 목포시 남악로 19",
                  x: "126.4414",
                  y: "34.8036",
                  road_address: { region_1depth_name: "전남", region_2depth_name: "목포시", address_name: "전남 목포시 남악로 19" },
                },
              ],
            }),
          };
        }
        if (q.includes("신남리 454")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              documents: [
                {
                  address_type: "REGION_ADDR",
                  address_name: "강원특별자치도 인제군 남면 신남리 454",
                  x: "128.081",
                  y: "38.019",
                  address: { region_1depth_name: "강원특별자치도", region_2depth_name: "인제군", address_name: "강원특별자치도 인제군 남면 신남리 454" },
                },
              ],
            }),
          };
        }
        if (q.includes("오상리 968-1")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              documents: [
                {
                  address_type: "REGION_ADDR",
                  address_name: "경북 상주시 중동면 오상리 968-1",
                  x: "128.251",
                  y: "36.412",
                  address: { region_1depth_name: "경북", region_2depth_name: "상주시", address_name: "경북 상주시 중동면 오상리 968-1" },
                },
              ],
            }),
          };
        }
        if (q.includes("용마도시자연공원")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              documents: [
                {
                  address_type: "REGION_ADDR",
                  address_name: "서울 광진구 중곡동 123",
                  x: "127.09",
                  y: "37.56",
                  address: { region_1depth_name: "서울", region_2depth_name: "광진구", address_name: "서울 광진구 중곡동 123" },
                },
              ],
            }),
          };
        }
        if (q.includes("신남리 999")) {
          // Wrong province returned by Kakao despite 인제군청 agency -> must be rejected as uncertain!
          return {
            ok: true,
            status: 200,
            json: async () => ({
              documents: [
                {
                  address_type: "REGION_ADDR",
                  address_name: "충남 태안군 남면 신남리 999",
                  x: "126.31",
                  y: "36.65",
                  address: { region_1depth_name: "충남", region_2depth_name: "태안군", address_name: "충남 태안군 남면 신남리 999" },
                },
              ],
            }),
          };
        }
        return { ok: true, status: 200, json: async () => ({ documents: [] }) };
      });

      const adapter = createBatchPgliteAdapter(db);
      const geo = createKakaoAddressGeocoder({
        apiKey: "test-key",
        minDelayMs: 0,
        fetchImpl: mockFetch as any,
      });

      const res = await importPublicRestrooms(adapter, csv, {
        dryRun: false,
        cityFilter: null,
        batchSize: 10,
        skipUnlocatedNew: true,
        geocoder: geo,
      });

      expect(res.status).toBe("success");
      expect(res.insertedCount).toBe(4);
      expect(res.geocodeSuccessCount).toBe(4);
      expect(res.geocodeFailedCount).toBe(2);
      expect(res.skippedUnlocatedNewCount).toBe(2);
      // REG-UNCERTAIN-1 had 0 HTTP calls; REG-OK-3 never queried "부여불가"
      const queries = mockFetch.mock.calls.map((c) =>
        decodeURIComponent(new URL(c[0] as string).searchParams.get("query") || "")
      );
      expect(queries.some((q) => q.includes("부여불가"))).toBe(false);
      expect(queries.some((q) => q.includes("서창로 194"))).toBe(false);

      const dbRes: any = await db.query(
        `SELECT source_record_id FROM public.restrooms WHERE source_record_id LIKE 'REG-%' ORDER BY source_record_id`
      );
      expect(dbRes.rows.map((r: any) => r.source_record_id)).toEqual([
        "REG-OK-1",
        "REG-OK-2",
        "REG-OK-3",
        "REG-OK-4",
      ]);
    });
  });
});
