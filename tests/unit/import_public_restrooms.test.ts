import { describe, expect, it, vi, beforeEach, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import {
  parseCsv,
  decodeCsvBuffer,
  normalizeRecord,
  importPublicRestrooms,
  getOrCreatePublicSource,
  buildAddressQueryCandidates,
  evaluateKakaoDocument,
  DEFAULT_SUWON_SOURCE_CONFIG,
  type RawPublicRestroomRecord,
} from "@/lib/imports";

describe("TASK 11 — Public Restroom Data Import & Normalization", () => {
  const sampleCsvPath = path.resolve(
    process.cwd(),
    "tests/fixtures/public/suwon_public_restrooms_sample.csv"
  );
  const sampleCsvText = fs.readFileSync(sampleCsvPath, "utf8");

  // ==========================================================================
  // 1. CSV Parser Unit Tests
  // ==========================================================================
  describe("1. RFC 4180 CSV Parser", () => {
    it("1.1 parses standard CSV headers and rows correctly", () => {
      const csv = `이름,주소,위도\n화장실A,수원시 팔달구,37.28\n화장실B,수원시 장안구,37.29`;
      const records = parseCsv(csv);
      expect(records).toHaveLength(2);
      expect(records[0]["이름"]).toBe("화장실A");
      expect(records[0]["주소"]).toBe("수원시 팔달구");
      expect(records[0]["위도"]).toBe("37.28");
      expect(records[1]["이름"]).toBe("화장실B");
    });

    it("1.2 handles quoted values with commas and line breaks", () => {
      const csv = `화장실명,설명,주소\n"중앙, 공원 화장실","개방시간:\n24시간 개방","수원시 팔달구"`;
      const records = parseCsv(csv);
      expect(records).toHaveLength(1);
      expect(records[0]["화장실명"]).toBe("중앙, 공원 화장실");
      expect(records[0]["설명"]).toBe("개방시간:\n24시간 개방");
      expect(records[0]["주소"]).toBe("수원시 팔달구");
    });

    it("1.3 strips UTF-8 BOM if present", () => {
      const csv = `\uFEFF화장실명,구분\n화홍문,공중화장실`;
      const records = parseCsv(csv);
      expect(records).toHaveLength(1);
      expect(records[0]["화장실명"]).toBe("화홍문");
    });

    it("1.4 handles empty trailing lines safely", () => {
      const csv = `화장실명,구분\n화홍문,공중화장실\n\n   \n`;
      const records = parseCsv(csv);
      expect(records).toHaveLength(1);
    });
  });

  // ==========================================================================
  // 2. Record Normalization & Schema Validation
  // ==========================================================================
  describe("2. Record Normalization & Quarantine", () => {
    it("2.1 normalizes valid record into published public restroom with coords", () => {
      const raw: RawPublicRestroomRecord = {
        화장실관리번호: "SUWON-PB-001",
        화장실명: "화홍문 공중화장실",
        소재지도로명주소: "경기도 수원시 팔달구 수원천로 374",
        소재지지번주소: "경기도 수원시 팔달구 북수동 25-1",
        남녀공용화장실여부: "N",
        "남성용-장애인용대변기수": "1",
        "여성용-장애인용대변기수": "1",
        WGS84위도: "37.287123",
        WGS84경도: "127.018456",
        기저귀교환대유무: "Y",
        데이터기준일자: "2026-10-01",
      };

      const result = normalizeRecord(raw, 0);
      expect(result.error).toBeUndefined();
      expect(result.parsed).toBeDefined();

      const p = result.parsed!;
      expect(p.sourceRecordId).toBe("SUWON-PB-001");
      expect(p.name).toBe("화홍문 공중화장실");
      expect(p.roadAddress).toBe("경기도 수원시 팔달구 수원천로 374");
      expect(p.addressDetail).toContain("북수동 25-1");
      expect(p.latitude).toBeCloseTo(37.287123);
      expect(p.longitude).toBeCloseTo(127.018456);
      expect(p.publicationStatus).toBe("published");
      expect(p.genderType).toBe("separate");
      expect(p.wheelchairAccessible).toBe(true);
      expect(p.babyChangingAvailable).toBe(true);
      expect(p.accessMethod).toBe("open"); // Public is strictly open (NO PIN)
    });

    it("2.2 rejects records with missing restroom name", () => {
      const raw: RawPublicRestroomRecord = {
        화장실관리번호: "ERR-01",
        소재지도로명주소: "경기도 수원시 팔달구 수원천로 1",
      };
      const result = normalizeRecord(raw, 0);
      expect(result.error).toContain("화장실명");
      expect(result.parsed).toBeUndefined();
    });

    it("2.3 falls back to jibun address if road address is missing", () => {
      const raw: RawPublicRestroomRecord = {
        화장실관리번호: "JIBUN-01",
        화장실명: "지번 전용 화장실",
        소재지지번주소: "경기도 수원시 장안구 영화동 100-2",
        WGS84위도: "37.295123",
        WGS84경도: "127.012345",
      };
      const result = normalizeRecord(raw, 0);
      expect(result.error).toBeUndefined();
      expect(result.parsed?.roadAddress).toBe("경기도 수원시 장안구 영화동 100-2");
      expect(result.parsed?.publicationStatus).toBe("published");
    });

    it("2.4 rejects records with both road address and jibun address missing", () => {
      const raw: RawPublicRestroomRecord = {
        화장실관리번호: "NO-ADDR",
        화장실명: "주소 없는 화장실",
      };
      const result = normalizeRecord(raw, 0);
      expect(result.error).toContain("주소가 모두 누락");
    });

    it("2.5 quarantines missing coordinates as draft (coords null)", () => {
      const raw: RawPublicRestroomRecord = {
        화장실관리번호: "NO-COORDS",
        화장실명: "임시 간이화장실",
        소재지도로명주소: "경기도 수원시 팔달구 신풍로 20",
        WGS84위도: "", // Empty coords
        WGS84경도: "",
      };
      const result = normalizeRecord(raw, 0);
      expect(result.error).toBeUndefined();
      const p = result.parsed!;
      expect(p.latitude).toBeNull();
      expect(p.longitude).toBeNull();
      expect(p.publicationStatus).toBe("draft"); // Quarantined from public discovery
    });

    it("2.6 quarantines out-of-range coordinates as draft", () => {
      const raw: RawPublicRestroomRecord = {
        화장실관리번호: "OUT-OF-BOUNDS",
        화장실명: "좌표 오류 화장실",
        소재지도로명주소: "경기도 수원시 팔달구 신풍로 20",
        WGS84위도: "99.999", // Invalid latitude > 90
        WGS84경도: "127.01",
      };
      const result = normalizeRecord(raw, 0);
      expect(result.error).toBeUndefined();
      expect(result.parsed?.latitude).toBeNull();
      expect(result.parsed?.longitude).toBeNull();
      expect(result.parsed?.publicationStatus).toBe("draft");
    });

    it("2.7 caps future verification timestamp to current time (prevents SQLSTATE 22007)", () => {
      const raw: RawPublicRestroomRecord = {
        화장실관리번호: "FUTURE-DATE",
        화장실명: "미래 기준일자 화장실",
        소재지도로명주소: "수원시 팔달구 정조로 1",
        데이터기준일자: "2099-12-31", // Future timestamp
      };
      const result = normalizeRecord(raw, 0);
      expect(result.error).toBeUndefined();
      const parsedTime = new Date(result.parsed!.lastVerifiedAt).getTime();
      const now = Date.now();
      expect(parsedTime).toBeLessThanOrEqual(now + 1000); // Should be capped to now
    });

    it("2.8 generates stable sourceRecordId when none is provided", () => {
      const raw: RawPublicRestroomRecord = {
        화장실명: "이름만 있는 화장실",
        소재지도로명주소: "수원시 팔달구 정조로 1",
      };
      const res1 = normalizeRecord(raw, 0);
      const res2 = normalizeRecord(raw, 0);
      expect(res1.parsed?.sourceRecordId).toBeDefined();
      expect(res1.parsed?.sourceRecordId).toMatch(/^SUWON-GEN-/);
      expect(res1.parsed?.sourceRecordId).toBe(res2.parsed?.sourceRecordId); // Stable hash
    });

    it("2.9 normalizes whitespace in name and address for fallback hash ID", () => {
      const raw1: RawPublicRestroomRecord = {
        화장실명: "행궁동  화장실", // extra space
        소재지도로명주소: "수원시 팔달구  정조로 10",
      };
      const raw2: RawPublicRestroomRecord = {
        화장실명: "행궁동 화장실",
        소재지도로명주소: "수원시 팔달구 정조로 10",
      };
      const res1 = normalizeRecord(raw1, 0);
      const res2 = normalizeRecord(raw2, 0);
      expect(res1.parsed?.sourceRecordId).toBe(res2.parsed?.sourceRecordId);
    });

    it("2.10 skips records not matching cityFilter", () => {
      const rawOtherCity: RawPublicRestroomRecord = {
        화장실명: "종로 공중화장실",
        소재지도로명주소: "서울특별시 종로구 종로 1",
        관리기관명: "종로구청",
      };
      const res = normalizeRecord(rawOtherCity, 0, { cityFilter: "수원" });
      expect(res.skipped).toBe(true);
      expect(res.parsed).toBeUndefined();
    });

    it("2.11 skips records where agency is 수원 but address is in another city", () => {
      const rawSuwonAgencyOtherCity: RawPublicRestroomRecord = {
        화장실명: "수원지방법원 안산지원 공중화장실",
        소재지도로명주소: "경기도 안산시 단원구 광덕서로 75",
        소재지지번주소: "경기도 안산시 단원구 고잔동 709",
        관리기관명: "수원지방법원",
      };
      const res = normalizeRecord(rawSuwonAgencyOtherCity, 0, { cityFilter: "수원" });
      expect(res.skipped).toBe(true);
      expect(res.parsed).toBeUndefined();
    });

    it("2.12 maps localdata 관리번호 and decodes CP949 buffer", () => {
      // "관리번호,화장실명,소재지도로명주소\n202437400000101527,수원화장실,경기도 수원시 팔달구 정조로 833" in EUC-KR/CP949 bytes
      const cp949Bytes = Uint8Array.from([
        0xb0, 0xfc, 0xb8, 0xae, 0xb9, 0xf8, 0xc8, 0xa3, 0x2c, // 관리번호,
        0xc8, 0xad, 0xc0, 0xe5, 0xbd, 0xc7, 0xb8, 0xed, 0x2c, // 화장실명,
        0xbc, 0xd2, 0xc0, 0xe7, 0xc1, 0xf6, 0xb5, 0xb5, 0xb7, 0xce, 0xb8, 0xed, 0xc1, 0xd6, 0xbc, 0xd2, 0x0a, // 소재지도로명주소\n
        0x32, 0x30, 0x32, 0x34, 0x33, 0x37, 0x34, 0x30, 0x30, 0x30, 0x30, 0x30, 0x31, 0x30, 0x31, 0x35, 0x32, 0x37, 0x2c, // 202437400000101527,
        0xbc, 0xf6, 0xbf, 0xf8, 0xc8, 0xad, 0xc0, 0xe5, 0xbd, 0xc7, 0x2c, // 수원화장실,
        0xb0, 0xe6, 0xb1, 0xe2, 0xb5, 0xb5, 0x20, 0xbc, 0xf6, 0xbf, 0xf8, 0xbd, 0xc3, 0x20, 0xc6, 0xc8, 0xb4, 0xde, 0xb1, 0xb8, 0x20, 0xc1, 0xa4, 0xc1, 0xb6, 0xb7, 0xce, 0x20, 0x38, 0x33, 0x33, // 경기도 수원시 팔달구 정조로 833
      ]);

      const decoded = decodeCsvBuffer(cp949Bytes, "auto");
      const records = parseCsv(decoded);
      expect(records).toHaveLength(1);
      const res = normalizeRecord(records[0], 0, { cityFilter: "수원시" });
      expect(res.parsed?.sourceRecordId).toBe("202437400000101527");
      expect(res.parsed?.name).toBe("수원화장실");
      expect(res.parsed?.publicationStatus).toBe("draft");
    });

    it("2.13 rejects uncertain REGION-only and cross-city Kakao geocode documents", () => {
      const candidates = buildAddressQueryCandidates(
        "경기도 수원시 영통구 광교호수로 127(하동)",
        "경기도 수원시 영통구 하동 1023"
      );
      expect(candidates[0]).toBe("경기도 수원시 영통구 광교호수로 127(하동)");
      expect(candidates).toContain("경기도 수원시 영통구 광교호수로 127");
      expect(candidates).toContain("경기도 수원시 영통구 하동 1023");

      const regionOnly = evaluateKakaoDocument(
        { address_type: "REGION", address_name: "경기 수원시 팔달구 인계동", x: "127.03", y: "37.27" },
        "수원시"
      );
      expect(regionOnly.valid).toBe(false);

      const wrongCity = evaluateKakaoDocument(
        { address_type: "ROAD_ADDR", address_name: "경기 화성시 태안로 1", x: "127.01", y: "37.21" },
        "수원시"
      );
      expect(wrongCity.valid).toBe(false);

      const validDoc = evaluateKakaoDocument(
        { address_type: "ROAD_ADDR", address_name: "경기 수원시 팔달구 정조로 833", x: "127.0158", y: "37.2827" },
        "수원시"
      );
      expect(validDoc.valid).toBe(true);
      expect(validDoc.latitude).toBeCloseTo(37.2827);
      expect(validDoc.longitude).toBeCloseTo(127.0158);
    });
  });

  // ==========================================================================
  // 3. Import Service & Database Operations
  // ==========================================================================
  describe("3. Import Service & Idempotent Upsert", () => {
    // In-memory mock database state
    let mockSources: any[] = [];
    let mockRuns: any[] = [];
    let mockRestrooms: any[] = [];
    let mockPolicies: any[] = [];

    function createMockSupabase() {
      return {
        from: vi.fn((table: string) => {
          if (table === "public_data_sources") {
            let filterProvider: string | null = null;
            let filterDataset: string | null = null;

            const chain: any = {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn((col: string, val: string) => {
                if (col === "provider_name") filterProvider = val;
                if (col === "dataset_name") filterDataset = val;
                if (col === "id") filterProvider = val;
                return chain;
              }),
              maybeSingle: vi.fn(() => {
                const found = mockSources.find((s) => {
                  if (filterProvider && s.provider_name !== filterProvider && s.id !== filterProvider) return false;
                  if (filterDataset && s.dataset_name !== filterDataset) return false;
                  return true;
                });
                return Promise.resolve({ data: found ?? null, error: null });
              }),
              insert: vi.fn((row: any) => {
                const inserted = { id: `src-${mockSources.length + 1}`, ...row };
                mockSources.push(inserted);
                return {
                  select: vi.fn().mockReturnValue({
                    single: vi.fn().mockResolvedValue({ data: inserted, error: null }),
                  }),
                };
              }),
              update: vi.fn((patch: any) => ({
                eq: vi.fn((col: string, val: string) => {
                  const target = mockSources.find((s) => s.id === val);
                  if (target) Object.assign(target, patch);
                  return Promise.resolve({ data: target, error: null });
                }),
              })),
            };
            return chain;
          }

          if (table === "public_import_runs") {
            const chain: any = {
              insert: vi.fn((row: any) => {
                const inserted = { id: `run-${mockRuns.length + 1}`, ...row };
                mockRuns.push(inserted);
                return {
                  select: vi.fn().mockReturnValue({
                    single: vi.fn().mockResolvedValue({ data: inserted, error: null }),
                  }),
                };
              }),
              update: vi.fn((patch: any) => ({
                eq: vi.fn((col: string, val: string) => {
                  const target = mockRuns.find((r) => r.id === val);
                  if (target) Object.assign(target, patch);
                  return Promise.resolve({ data: target, error: null });
                }),
              })),
            };
            return chain;
          }

          if (table === "restrooms") {
            let filterSourceId: string | null = null;
            let filterSourceRecordId: string | null = null;

            const chain: any = {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn((col: string, val: string) => {
                if (col === "source_id") filterSourceId = val;
                if (col === "source_record_id") filterSourceRecordId = val;
                return chain;
              }),
              maybeSingle: vi.fn(() => {
                const found = mockRestrooms.find((r) => {
                  if (filterSourceId && r.source_id !== filterSourceId) return false;
                  if (filterSourceRecordId && r.source_record_id !== filterSourceRecordId) return false;
                  return true;
                });
                return Promise.resolve({ data: found ?? null, error: null });
              }),
              insert: vi.fn((row: any) => {
                const inserted = { id: `restroom-${mockRestrooms.length + 1}`, ...row };
                mockRestrooms.push(inserted);
                return {
                  select: vi.fn().mockReturnValue({
                    single: vi.fn().mockResolvedValue({ data: inserted, error: null }),
                  }),
                };
              }),
              update: vi.fn((patch: any) => ({
                eq: vi.fn((col: string, val: string) => {
                  const target = mockRestrooms.find((r) => r.id === val);
                  if (target) Object.assign(target, patch);
                  return Promise.resolve({ data: target, error: null });
                }),
              })),
            };
            return chain;
          }

          if (table === "restroom_access_policies") {
            const chain: any = {
              insert: vi.fn((row: any) => {
                const inserted = { id: `pol-${mockPolicies.length + 1}`, ...row };
                mockPolicies.push(inserted);
                return Promise.resolve({ data: inserted, error: null });
              }),
            };
            return chain;
          }

          return {} as any;
        }),
      } as any;
    }

    beforeEach(() => {
      mockSources = [];
      mockRuns = [];
      mockRestrooms = [];
      mockPolicies = [];
    });

    it("3.1 executes dry-run without writing to database", async () => {
      const client = createMockSupabase();
      const result = await importPublicRestrooms(client, sampleCsvText, { dryRun: true });

      expect(result.status).toBe("success");
      expect(result.runId).toBe("dry-run");
      expect(result.fetchedCount).toBe(5);
      expect(result.insertedCount).toBe(4); // 4 valid records
      expect(result.errorCount).toBe(1); // 1 defective record
      // Verify DB was NOT written
      expect(mockSources).toHaveLength(0);
      expect(mockRuns).toHaveLength(0);
      expect(mockRestrooms).toHaveLength(0);
      expect(mockPolicies).toHaveLength(0);
    });

    it("3.2 first import: inserts valid records and creates free policies", async () => {
      const client = createMockSupabase();
      const result = await importPublicRestrooms(client, sampleCsvText);

      expect(result.status).toBe("success");
      expect(result.fetchedCount).toBe(5);
      expect(result.insertedCount).toBe(4);
      expect(result.updatedCount).toBe(0);
      expect(result.skippedCount).toBe(0);
      expect(result.errorCount).toBe(1);

      // Verify DB records
      expect(mockSources).toHaveLength(1);
      expect(mockSources[0].dataset_name).toBe(DEFAULT_SUWON_SOURCE_CONFIG.datasetName);
      expect(mockSources[0].last_synced_at).toBeDefined();

      expect(mockRuns).toHaveLength(1);
      expect(mockRuns[0].status).toBe("success");
      expect(mockRuns[0].inserted_count).toBe(4);
      expect(mockRuns[0].error_count).toBe(1);

      expect(mockRestrooms).toHaveLength(4);
      // Verify quarantined draft
      const draft = mockRestrooms.find((r) => r.source_record_id === "SUWON-PB-003");
      expect(draft?.publication_status).toBe("draft");
      expect(draft?.latitude).toBeNull();

      // Verify published
      const published = mockRestrooms.find((r) => r.source_record_id === "SUWON-PB-001");
      expect(published?.publication_status).toBe("published");
      expect(published?.latitude).toBeCloseTo(37.287123);

      // Verify each inserted public restroom has a free access policy
      expect(mockPolicies).toHaveLength(4);
      mockPolicies.forEach((pol) => {
        expect(pol.access_mode).toBe("free");
        expect(pol.deposit_amount_krw).toBe(0);
        expect(pol.is_active).toBe(true);
      });
    });

    it("3.3 second import with same data: produces 0 duplicates (Idempotency)", async () => {
      const client = createMockSupabase();

      // Run 1
      const res1 = await importPublicRestrooms(client, sampleCsvText);
      expect(res1.insertedCount).toBe(4);
      expect(mockRestrooms).toHaveLength(4);

      // Run 2 (Same CSV)
      const res2 = await importPublicRestrooms(client, sampleCsvText);
      expect(res2.status).toBe("success");
      expect(res2.fetchedCount).toBe(5);
      expect(res2.insertedCount).toBe(0); // 0 new inserts!
      expect(res2.updatedCount).toBe(0);
      expect(res2.skippedCount).toBe(4); // 4 unchanged records skipped
      expect(res2.errorCount).toBe(1);

      // Restroom count strictly preserved (NO duplicates)
      expect(mockRestrooms).toHaveLength(4);
      expect(mockPolicies).toHaveLength(4);
      expect(mockRuns).toHaveLength(2); // 2nd run logged
    });

    it("3.4 updates modified record when source content changes", async () => {
      const client = createMockSupabase();
      await importPublicRestrooms(client, sampleCsvText);

      // Modified CSV: SUWON-PB-001 name and address changed
      const modifiedCsv = sampleCsvText.replace(
        "화홍문 공중화장실",
        "화홍문 리모델링 화장실"
      );

      const resUpdate = await importPublicRestrooms(client, modifiedCsv);
      expect(resUpdate.status).toBe("success");
      expect(resUpdate.insertedCount).toBe(0);
      expect(resUpdate.updatedCount).toBe(1); // 1 updated!
      expect(resUpdate.skippedCount).toBe(3); // 3 unchanged

      const updated = mockRestrooms.find((r) => r.source_record_id === "SUWON-PB-001");
      expect(updated?.name).toBe("화홍문 리모델링 화장실");
    });

    it("3.5 deduplicates records within same CSV file keeping the first", async () => {
      const client = createMockSupabase();
      const duplicateCsv = `화장실관리번호,화장실명,소재지도로명주소,WGS84위도,WGS84경도\nDUP-01,중복1차,수원시 팔달구 1,37.28,127.01\nDUP-01,중복2차(폐기대상),수원시 팔달구 2,37.29,127.02`;

      const res = await importPublicRestrooms(client, duplicateCsv);
      expect(res.fetchedCount).toBe(2);
      expect(res.insertedCount).toBe(1); // Only 1 inserted
      expect(res.errorCount).toBe(1); // Second was flagged as duplicate error
      expect(res.errors[0].reason).toContain("중복된 원천 식별자");

      expect(mockRestrooms).toHaveLength(1);
      expect(mockRestrooms[0].name).toBe("중복1차");
    });

    it("3.6 records failed status in import_runs when initialization throws", async () => {
      const client = {
        from: vi.fn(() => ({
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockRejectedValue(new Error("DB Connection Error")),
        })),
      } as any;

      const res = await importPublicRestrooms(client, sampleCsvText);
      expect(res.status).toBe("failed");
      expect(res.errorMessage).toContain("DB Connection Error");
    });

    it("3.7 preserves archived and suspended status when re-importing existing restrooms", async () => {
      const client = createMockSupabase();
      await importPublicRestrooms(client, sampleCsvText);

      // Admin archives one restroom (e.g. facility demolition or closure)
      const target = mockRestrooms.find((r) => r.source_record_id === "SUWON-PB-001");
      expect(target).toBeDefined();
      target.publication_status = "archived";

      // Re-importing same or updated dataset should NOT restore it to 'published'
      const reimportRes = await importPublicRestrooms(client, sampleCsvText, {
        preserveAdminStatus: true,
      });

      expect(reimportRes.status).toBe("success");
      const preserved = mockRestrooms.find((r) => r.source_record_id === "SUWON-PB-001");
      expect(preserved?.publication_status).toBe("archived"); // Preserved!
    });

    it("3.8 filters out records not matching cityFilter option", async () => {
      const client = createMockSupabase();
      const nationalCsv = `화장실관리번호,화장실명,소재지도로명주소,관리기관명,WGS84위도,WGS84경도\nNAT-01,수원 화장실,경기도 수원시 팔달구 1,수원시청,37.28,127.01\nNAT-02,서울 화장실,서울특별시 중구 세종대로 110,서울시청,37.56,126.97`;

      const result = await importPublicRestrooms(client, nationalCsv, {
        cityFilter: "수원",
      });

      expect(result.status).toBe("success");
      expect(result.fetchedCount).toBe(2);
      expect(result.insertedCount).toBe(1); // Only 수원 화장실
      expect(result.skippedCount).toBe(1); // 서울 화장실 skipped

      expect(mockRestrooms).toHaveLength(1);
      expect(mockRestrooms[0].name).toBe("수원 화장실");
    });

    it("3.9 geocodes missing coordinates in dry-run and quarantines failed/uncertain rows", async () => {
      const client = createMockSupabase();
      const rawCsv = [
        "관리번호,화장실명,소재지도로명주소,소재지지번주소",
        "SW-1,성공화장실,경기도 수원시 팔달구 정조로 833,",
        "SW-2,실패화장실,경기도 수원시 팔달구 없는길 999,",
      ].join("\n");

      const mockGeocoder = vi.fn(async ({ roadAddress }) => {
        if (roadAddress.includes("정조로 833")) {
          return {
            status: "success" as const,
            latitude: 37.2827,
            longitude: 127.0158,
          };
        }
        return {
          status: "not_found" as const,
          latitude: null,
          longitude: null,
          reason: "주소 없음",
        };
      });

      const result = await importPublicRestrooms(client, rawCsv, {
        dryRun: true,
        cityFilter: "수원시",
        geocoder: mockGeocoder,
      });

      expect(result.status).toBe("success");
      expect(result.cityMatchedCount).toBe(2);
      expect(result.geocodeSuccessCount).toBe(1);
      expect(result.geocodeFailedCount).toBe(1);
      expect(result.publishedCount).toBe(1);
      expect(result.draftCount).toBe(1);
      expect(result.insertedCount).toBe(2);
      expect(mockRestrooms).toHaveLength(0); // dry-run does not touch DB
    });
  });

  // ==========================================================================
  // 4. PGlite Real PostgreSQL Schema Constraints & Triggers
  // ==========================================================================
  describe("4. PGlite Schema Constraints & Triggers", () => {
    let db: PGlite;
    let sourceId: string;

    beforeAll(async () => {
      db = new PGlite();

      // Mock auth schema
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

      // Apply 5 migrations
      const ROOT = process.cwd();
      const m1 = fs.readFileSync(path.join(ROOT, "supabase/migrations/20261106000000_auth_schema.sql"), "utf8");
      await db.exec(m1);
      const m2 = fs.readFileSync(path.join(ROOT, "supabase/migrations/20261107000000_lead_tracking.sql"), "utf8");
      await db.exec(m2);
      const m3 = fs.readFileSync(path.join(ROOT, "supabase/migrations/20261108000000_business_backend.sql"), "utf8");
      await db.exec(m3);
      const m4 = fs.readFileSync(path.join(ROOT, "supabase/migrations/20261109000000_audit_and_approval.sql"), "utf8");
      await db.exec(m4);
      const m5 = fs.readFileSync(path.join(ROOT, "supabase/migrations/20261110000000_restroom_schema.sql"), "utf8");
      await db.exec(m5);

      // Create a test public data source
      const srcRes: any = await db.query(`
        INSERT INTO public.public_data_sources (provider_name, dataset_name, source_url)
        VALUES ('수원시', '테스트공중화장실', 'https://example.com')
        RETURNING id;
      `);
      sourceId = srcRes.rows[0].id;
    }, 30000);

    afterAll(async () => {
      if (db) await db.close();
    });

    it("4.1 enforces idx_restrooms_source_unique on duplicate (source_id, source_record_id)", async () => {
      // First insert: succeeds
      await db.query(`
        INSERT INTO public.restrooms (
          source_id, source_record_id, type, name, road_address, latitude, longitude, publication_status
        ) VALUES (
          '${sourceId}', 'REC-DUP-01', 'public', '테스트 화장실 1', '수원시 팔달구 1', 37.28, 127.01, 'published'
        );
      `);

      // Duplicate insert with same source_id and source_record_id: must fail with unique constraint error
      await expect(
        db.query(`
          INSERT INTO public.restrooms (
            source_id, source_record_id, type, name, road_address, latitude, longitude, publication_status
          ) VALUES (
            '${sourceId}', 'REC-DUP-01', 'public', '중복 시도 화장실', '수원시 팔달구 2', 37.29, 127.02, 'published'
          );
        `)
      ).rejects.toThrow();
    });

    it("4.2 rejects public restroom with PIN access method (chk_restrooms_public_no_pin)", async () => {
      await expect(
        db.query(`
          INSERT INTO public.restrooms (
            source_id, source_record_id, type, name, road_address, latitude, longitude, access_method, publication_status
          ) VALUES (
            '${sourceId}', 'REC-PIN-ERR', 'public', '공공 PIN 불가 화장실', '수원시 팔달구 3', 37.28, 127.01, 'pin', 'published'
          );
        `)
      ).rejects.toThrow();
    });

    it("4.3 rejects published status when coordinates are null (chk_restrooms_published_has_coords)", async () => {
      await expect(
        db.query(`
          INSERT INTO public.restrooms (
            source_id, source_record_id, type, name, road_address, latitude, longitude, publication_status
          ) VALUES (
            '${sourceId}', 'REC-PUB-NO-COORDS', 'public', '좌표없는 공개 시도', '수원시 팔달구 4', null, null, 'published'
          );
        `)
      ).rejects.toThrow();
    });

    it("4.4 allows draft status when coordinates are both null", async () => {
      const res: any = await db.query(`
        INSERT INTO public.restrooms (
          source_id, source_record_id, type, name, road_address, latitude, longitude, publication_status
        ) VALUES (
          '${sourceId}', 'REC-DRAFT-NULL-COORDS', 'public', '좌표없는 임시 격리', '수원시 팔달구 5', null, null, 'draft'
        ) RETURNING id;
      `);
      expect(res.rows[0].id).toBeDefined();
    });

    it("4.5 rejects non-free access policy for public restroom (enforce_restroom_access_policy_rules)", async () => {
      const rRes: any = await db.query(`
        INSERT INTO public.restrooms (
          source_id, source_record_id, type, name, road_address, latitude, longitude, publication_status
        ) VALUES (
          '${sourceId}', 'REC-POL-TEST', 'public', '정책 검증 화장실', '수원시 팔달구 6', 37.28, 127.01, 'published'
        ) RETURNING id;
      `);
      const restroomId = rRes.rows[0].id;

      // Inserting deposit/fee policy on public restroom must be rejected by trigger
      await expect(
        db.query(`
          INSERT INTO public.restroom_access_policies (
            restroom_id, version, access_mode, deposit_amount_krw, refund_eligible, is_active, effective_from
          ) VALUES (
            '${restroomId}', 1, 'test_deposit', 1000, true, true, now()
          );
        `)
      ).rejects.toThrow();
    });
  });
});
