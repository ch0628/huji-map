import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  parseGgCsvRecords,
  matchSuwonRestroomsWithGgData,
  buildGgSourceRecordId,
  type SuwonDbRestroomCandidate,
} from "@/lib/imports/gg-suwon-coords";
import {
  validateRemoteExportPackage,
  type RemoteExportPackage,
} from "../../scripts/prepare-remote-suwon-migration";

describe("STEP 3 — Gyeonggi Public Data Suwon Coordinate Matching", () => {
  it("matches exact name + road/jibun lot and ignores trailing facility suffix on jibun", () => {
    const ggRows = parseGgCsvRecords([
      {
        화장실명: "청개구리",
        소재지도로명주소: "경기도 수원시 장안구 상률로 37-26(율전동)",
        소재지지번주소: "경기도 수원시 장안구 율전동 124-1",
        위도: "37.3070616987",
        경도: "126.9705099508",
        데이터기준일자: "20231219",
      },
      {
        화장실명: "팔달문",
        소재지도로명주소: "경기도 수원시 팔달구 팔달로3가 103(행궁동)",
        소재지지번주소: "경기도 수원시 팔달구 행궁동",
        위도: "37.2777001",
        경도: "127.0168002",
        데이터기준일자: "20231219",
      },
    ]);

    const dbTargets: SuwonDbRestroomCandidate[] = [
      {
        id: "r-1",
        name: "청개구리",
        roadAddress:
          "경기도 수원시 장안구 상률로 37-18, 청개구리 공중화장실 (율전동)",
        addressDetail:
          "(지번) 경기도 수원시 장안구 율전동 124-1 청개구리 공중화장실(밤밭청개구리공원)",
        sourceId: "src-1",
        sourceRecordId: "202437400000101358",
        publicationStatus: "published",
        lastVerifiedAt: "2026-02-20T00:00:00Z",
      },
      {
        id: "r-2",
        name: "팔달문",
        roadAddress: "경기도 수원시 팔달구 팔달로3가 103(행궁동)",
        addressDetail: "(지번) 경기도 수원시 팔달구 행궁동",
        sourceId: "src-1",
        sourceRecordId: "202437400000101500",
        publicationStatus: "draft",
        lastVerifiedAt: null,
      },
    ];

    const report = matchSuwonRestroomsWithGgData(dbTargets, ggRows);
    expect(report.totalTargets).toBe(2);
    expect(report.matchedCount).toBe(2);
    expect(report.matchedPublishedCount).toBe(1);
    expect(report.matchedDraftCount).toBe(1);
    expect(report.items[0].status).toBe("matched");
    expect(report.items[0].matchBasis).toBe("name+jibun_lot");
    expect(report.items[0].coordinateSource).toBe("gg_publtolt_15011425");
    expect(report.items[0].coordinateSourceRecordId).toMatch(
      /^GG-15011425-R1-[a-f0-9]{12}$/
    );
    expect(report.items[0].latitude).toBeCloseTo(37.3070616987, 8);
    expect(report.items[1].status).toBe("matched");
    expect(report.items[1].matchBasis).toBe("name+road_strict");
  });

  it("holds back ambiguous matches when multiple candidate rows exist", () => {
    const ggRows = parseGgCsvRecords([
      {
        화장실명: "팔달노인복지관 지하1층",
        소재지도로명주소: "경기도 수원시 팔달구 수원천로 343(북수동)",
        소재지지번주소: "경기도 수원시 팔달구 북수동 274-7",
        위도: "37.2839431148",
        경도: "127.0173638025",
      },
      {
        화장실명: "팔달노인복지관 지하1층",
        소재지도로명주소: "경기도 수원시 팔달구 수원천로 343(북수동)",
        소재지지번주소: "경기도 수원시 팔달구 북수동 274-7",
        위도: "37.2839431148",
        경도: "127.0173638025",
      },
    ]);

    const report = matchSuwonRestroomsWithGgData(
      [
        {
          id: "r-amb",
          name: "팔달노인복지관 지하1층",
          roadAddress: "경기도 수원시 팔달구 수원천로 343(북수동)",
          addressDetail: "(지번) 경기도 수원시 팔달구 북수동 274-7",
          sourceId: "src-1",
          sourceRecordId: "202437400000101111",
          publicationStatus: "published",
          lastVerifiedAt: null,
        },
      ],
      ggRows
    );

    expect(report.matchedCount).toBe(0);
    expect(report.ambiguousCount).toBe(1);
    expect(report.eligibleForRemoteCount).toBe(0);
    expect(report.items[0].status).toBe("ambiguous");
    expect(report.items[0].candidateCount).toBe(2);
    expect(report.items[0].candidateRowNumbers).toEqual([1, 2]);
    expect(report.items[0].latitude).toBeNull();
  });

  it("marks matched row with blank or invalid coordinates as missing_coords", () => {
    const ggRows = parseGgCsvRecords([
      {
        화장실명: "연꽃",
        소재지도로명주소: "",
        소재지지번주소: "경기도 수원시 장안구 송죽동 434",
        위도: "",
        경도: "",
      },
      {
        화장실명: "이상좌표",
        소재지도로명주소: "경기도 수원시 장안구 송죽동 1",
        소재지지번주소: "경기도 수원시 장안구 송죽동 1",
        위도: "0",
        경도: "0",
      },
    ]);

    const report = matchSuwonRestroomsWithGgData(
      [
        {
          id: "r-miss-1",
          name: "연꽃",
          roadAddress: "경기도 수원시 장안구 송죽동 434",
          addressDetail: null,
          sourceId: "src-1",
          sourceRecordId: "202437400000101222",
          publicationStatus: "draft",
          lastVerifiedAt: null,
        },
        {
          id: "r-miss-2",
          name: "이상좌표",
          roadAddress: "경기도 수원시 장안구 송죽동 1",
          addressDetail: null,
          sourceId: "src-1",
          sourceRecordId: "202437400000101223",
          publicationStatus: "draft",
          lastVerifiedAt: null,
        },
      ],
      ggRows
    );

    expect(report.matchedCount).toBe(0);
    expect(report.missingCoordsCount).toBe(2);
    expect(report.items[0].status).toBe("missing_coords");
    expect(report.items[1].status).toBe("missing_coords");
  });

  it("does not match different restroom names sharing the same address", () => {
    const ggRows = parseGgCsvRecords([
      {
        화장실명: "창룡문지구대",
        소재지도로명주소: "경기도 수원시 장안구 경수대로 758(연무동)",
        소재지지번주소: "경기도 수원시 팔달구 연무동 254-11",
        위도: "37.2911550700",
        경도: "127.0220110633",
      },
    ]);

    const report = matchSuwonRestroomsWithGgData(
      [
        {
          id: "r-diff-name",
          name: "연무지구대",
          roadAddress: "경기도 수원시 장안구 경수대로 758(연무동)",
          addressDetail: "(지번) 경기도 수원시 팔달구 연무동 254-11",
          sourceId: "src-1",
          sourceRecordId: "202437400000101362",
          publicationStatus: "published",
          lastVerifiedAt: null,
        },
      ],
      ggRows
    );

    expect(report.matchedCount).toBe(0);
    expect(report.unmatchedCount).toBe(1);
    expect(report.items[0].status).toBe("unmatched");
  });

  it("generates deterministic GG source record identifiers", () => {
    const id1 = buildGgSourceRecordId({
      rowNumber: 6829,
      name: "청개구리",
      roadAddress: "경기도 수원시 장안구 상률로 37-26(율전동)",
      jibunAddress: "경기도 수원시 장안구 율전동 124-1",
      latitude: 37.3070616987,
      longitude: 126.9705099508,
    });
    const id2 = buildGgSourceRecordId({
      rowNumber: 6829,
      name: "청개구리",
      roadAddress: "경기도 수원시 장안구 상률로 37-26(율전동)",
      jibunAddress: "경기도 수원시 장안구 율전동 124-1",
      latitude: 37.3070616987,
      longitude: 126.9705099508,
    });
    expect(id1).toBe(id2);
    expect(id1).toMatch(/^GG-15011425-R6829-[a-f0-9]{12}$/);
  });

  it("validates remote export package strictly excludes partner, QA, draft, and Kakao coords", () => {
    const validPkg: RemoteExportPackage = {
      exportedAt: "2026-11-20T06:00:00Z",
      sourceFilter: "type='public' AND publication_status='published' AND coordinate_source='gg_publtolt_15011425'",
      counts: { publicDataSources: 2, restrooms: 1, activePolicies: 1 },
      publicDataSources: [
        { id: "src-15012892", provider_name: "경기도 수원시" },
        { id: "src-15011425", provider_name: "경기도" },
      ],
      restrooms: [
        {
          id: "rest-1",
          type: "public",
          publication_status: "published",
          coordinate_source: "gg_publtolt_15011425",
          source_id: "src-15012892",
          coordinate_source_id: "src-15011425",
          coordinate_source_record_id: "GG-15011425-R1-abcdef123456",
          business_id: null,
          created_by: null,
          approved_by: null,
          name: "청개구리",
          road_address: "경기도 수원시 장안구 상률로 37-18",
          latitude: 37.3070616987,
          longitude: 126.9705099508,
        },
      ],
      restroomAccessPolicies: [
        {
          id: "pol-1",
          restroom_id: "rest-1",
          access_mode: "free",
          deposit_amount_krw: 0,
          refund_eligible: false,
          is_active: true,
        },
      ],
    };

    expect(validateRemoteExportPackage(validPkg).valid).toBe(true);

    const kakaoPkg: RemoteExportPackage = {
      ...validPkg,
      restrooms: [{ ...validPkg.restrooms[0], coordinate_source: "kakao_geocode" }],
    };
    expect(validateRemoteExportPackage(kakaoPkg).valid).toBe(false);

    const partnerPkg: RemoteExportPackage = {
      ...validPkg,
      restrooms: [{ ...validPkg.restrooms[0], type: "partner", business_id: "biz-1" }],
    };
    expect(validateRemoteExportPackage(partnerPkg).valid).toBe(false);

    const qaPkg: RemoteExportPackage = {
      ...validPkg,
      restrooms: [{ ...validPkg.restrooms[0], name: "DEMO/TEST 화장실" }],
    };
    expect(validateRemoteExportPackage(qaPkg).valid).toBe(false);
  });

  it("verifies migration 20261122000000 adds coordinate provenance columns and protection trigger", () => {
    const migPath = path.resolve(
      process.cwd(),
      "supabase/migrations/20261122000000_restroom_coordinate_provenance.sql"
    );
    expect(fs.existsSync(migPath)).toBe(true);
    const sql = fs.readFileSync(migPath, "utf8");
    expect(sql).toContain("add column if not exists coordinate_source text null");
    expect(sql).toContain("add column if not exists coordinate_source_id uuid null");
    expect(sql).toContain("add column if not exists coordinate_source_record_id text null");
    expect(sql).toContain("'gg_publtolt_15011425'");
    expect(sql).toContain("'kakao_geocode'");
    expect(sql).toContain("protect_restroom_coordinate_provenance");
  });
});
