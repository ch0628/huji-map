import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildOpenCageRequestUrl,
  cleanKoreanAddressForGeocode,
  evaluateOpenCageResponse,
  parsePublicCsvRows,
  runOpenCageTrial,
  selectOpenCageSample,
} from "@/lib/imports/opencage";

describe("STEP 3 — OpenCage 100-Record Trial Helper", () => {
  it("cleans parenthetical remarks, commas, and dummy placeholders", () => {
    expect(
      cleanKoreanAddressForGeocode(
        "경기도 수원시 팔달구 효원로 1 (매산로3가, 경기도청)"
      )
    ).toBe("경기도 수원시 팔달구 효원로 1");
    expect(
      cleanKoreanAddressForGeocode("경기도 용인시 수지구 수지로 343, 새마을공원")
    ).toBe("경기도 용인시 수지구 수지로 343");
    expect(cleanKoreanAddressForGeocode("없음")).toBe("");
    expect(cleanKoreanAddressForGeocode("해당없음")).toBe("");
  });

  it("deterministically selects 100 gyeonggi samples without reading Kakao cache", () => {
    const mockRows = Array.from({ length: 250 }, (_, i) => ({
      관리번호: `M-${i + 1}`,
      화장실명: `화장실 ${i + 1}`,
      소재지도로명주소:
        i % 2 === 0
          ? `경기도 수원시 팔달구 효원로 ${i + 1}`
          : `서울특별시 종로구 사직로 ${i + 1}`,
      소재지지번주소: "",
    }));

    const selected = selectOpenCageSample(mockRows, {
      scope: "gyeonggi",
      limit: 100,
    });
    expect(selected).toHaveLength(100);
    expect(selected.every((s) => s.roadAddress.startsWith("경기도"))).toBe(
      true
    );
    expect(selected[0].sampleIndex).toBe(1);
    expect(selected[99].sampleIndex).toBe(100);
  });

  it("builds OpenCage request URL with kr/ko parameters", () => {
    const url = new URL(
      buildOpenCageRequestUrl("경기도 수원시 팔달구 효원로 1", "oc_test_key")
    );
    expect(url.origin + url.pathname).toBe(
      "https://api.opencagedata.com/geocode/v1/json"
    );
    expect(url.searchParams.get("q")).toBe("경기도 수원시 팔달구 효원로 1");
    expect(url.searchParams.get("countrycode")).toBe("kr");
    expect(url.searchParams.get("language")).toBe("ko");
    expect(url.searchParams.get("limit")).toBe("3");
    expect(url.searchParams.get("key")).toBe("oc_test_key");
  });

  it("evaluates matched, ambiguous, and not_found OpenCage responses", () => {
    const sample = {
      sampleIndex: 1,
      managementNo: "M-1",
      name: "수원화장실",
      roadAddress: "경기도 수원시 팔달구 효원로 1",
      jibunAddress: "",
      city: "수원시",
      queryAddress: "경기도 수원시 팔달구 효원로 1",
      fallbackQueryAddress: null,
    };

    const matched = evaluateOpenCageResponse(sample, sample.queryAddress, 200, {
      status: { code: 200, message: "OK" },
      results: [
        {
          formatted: "경기도 수원시 팔달구 효원로 1, 대한민국",
          confidence: 9,
          geometry: { lat: 37.275, lng: 127.009 },
          components: { country_code: "kr", city: "수원시" },
        },
      ],
    });
    expect(matched.status).toBe("matched");
    expect(matched.inKoreaBounds).toBe(true);
    expect(matched.inGyeonggiBounds).toBe(true);
    expect(matched.cityMatched).toBe(true);

    const mismatchedCity = evaluateOpenCageResponse(
      sample,
      sample.queryAddress,
      200,
      {
        status: { code: 200, message: "OK" },
        results: [
          {
            formatted: "경기도 용인시 기흥구",
            confidence: 8,
            geometry: { lat: 37.27, lng: 127.11 },
            components: { country_code: "kr", city: "용인시" },
          },
        ],
      }
    );
    expect(mismatchedCity.status).toBe("ambiguous");
    expect(mismatchedCity.cityMatched).toBe(false);

    const notFound = evaluateOpenCageResponse(
      sample,
      sample.queryAddress,
      200,
      {
        status: { code: 200, message: "OK" },
        results: [],
      }
    );
    expect(notFound.status).toBe("not_found");
  });

  it("blocks HTTP calls in dry-run, unconfirmed live, or missing-key modes", async () => {
    const fetchSpy = vi.fn();
    const samples = selectOpenCageSample(
      parsePublicCsvRows(
        "관리번호,화장실명,소재지도로명주소,소재지지번주소\nM1,테스트,경기도 수원시 팔달구 효원로 1,"
      )
    );

    const dryRes = await runOpenCageTrial(samples, {
      dryRun: true,
      apiKey: "oc_test",
      fetchImpl: fetchSpy,
    });
    expect(dryRes.blockedReason).toContain("DRY-RUN");
    expect(fetchSpy).not.toHaveBeenCalled();

    const unconfirmedRes = await runOpenCageTrial(samples, {
      dryRun: false,
      confirmed: false,
      apiKey: "oc_test",
      fetchImpl: fetchSpy,
    });
    expect(unconfirmedRes.blockedReason).toContain("--confirm");
    expect(fetchSpy).not.toHaveBeenCalled();

    const noKeyRes = await runOpenCageTrial(samples, {
      dryRun: false,
      confirmed: true,
      apiKey: "",
      fetchImpl: fetchSpy,
    });
    expect(noKeyRes.blockedReason).toContain("OPENCAGE_API_KEY 설정 필요");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("runs live flow against mocked OpenCage API and saves sanitized output without leaking key", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "hujimap-opencage-"));
    const outPath = path.join(tmpDir, "trial.json");
    const secretKey = "oc_secret_do_not_leak";

    const fetchMock = vi.fn(async () => ({
      status: 200,
      json: async () => ({
        status: { code: 200, message: "OK" },
        rate: { limit: 2500, remaining: 2499, reset: 1790000000 },
        results: [
          {
            formatted: "경기도 수원시 팔달구 효원로 1",
            confidence: 9,
            geometry: { lat: 37.2749, lng: 127.0094 },
            components: { country_code: "kr", city: "수원시" },
          },
        ],
      }),
    }));

    const samples = selectOpenCageSample(
      parsePublicCsvRows(
        "관리번호,화장실명,소재지도로명주소,소재지지번주소\nM1,테스트화장실,경기도 수원시 팔달구 효원로 1,"
      )
    );

    const res = await runOpenCageTrial(samples, {
      apiKey: secretKey,
      dryRun: false,
      confirmed: true,
      minDelayMs: 1100,
      fetchImpl: fetchMock as unknown as typeof fetch,
      outPath,
    });

    expect(res.blockedReason).toBeUndefined();
    expect(res.summary.httpCallsUsed).toBe(1);
    expect(res.summary.matchedCount).toBe(1);
    expect(res.summary.rateLimitRemaining).toBe(2499);
    expect(res.summary.attributionNotice).toContain("OpenStreetMap");

    const written = fs.readFileSync(outPath, "utf8");
    expect(written).not.toContain(secretKey);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
