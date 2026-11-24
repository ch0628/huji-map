#!/usr/bin/env node
/**
 * Read-only local PoC runner for MOIS Address DB validation (TASK-01 ~ TASK-09).
 * - Never writes to local or remote Supabase.
 * - Never calls external geocoding APIs.
 * - Streams ZIP/7z entries line-by-line via Python cp949->utf8 + bsdtar without unpacking GBs to disk.
 *
 * Usage:
 *   npx tsx scripts/address-db-poc/run-poc.ts --mode inventory
 *   npx tsx scripts/address-db-poc/run-poc.ts --mode suwon
 *   npx tsx scripts/address-db-poc/run-poc.ts --mode nationwide
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import readline from "node:readline";
import { decodeCsvBuffer, parseCsv } from "../../src/lib/imports/parser";
import {
  SummaryAddressIndex,
  NavigationAddressIndex,
  parseSummaryRow,
  parseNavBuildRow,
  parseNavJibunRow,
  parseNavAuxEntranceRow,
  parseRoadAddress,
  parseJibunAddress,
  buildRoadKey,
  buildJibunKey,
  stripAdminDongNumber,
  canonicalizeSido,
  extractAddressHints,
  isPlaceholderAddress,
  matchRestroomSummaryOnly,
  matchRestroomCombined,
  computeDistanceMetrics,
  type RestroomTarget,
  type SummaryMatchResult,
  type CombinedMatchResult,
} from "./lib";

const SUMMARY_ZIP_PATH = path.resolve(
  process.cwd(),
  "local-data/202610_위치정보요약DB_전체분.zip"
);
const NAV_7Z_PATH = path.resolve(
  process.cwd(),
  "local-data/202610_내비게이션용DB_전체분.7z"
);
const SUWON_EXPORT_PATH = path.resolve(
  process.cwd(),
  "local-data/suwon_remote_export.json"
);
const RAW_CSV_PATH = path.resolve(
  process.cwd(),
  "local-data/public_restroom_raw.csv"
);
const OUT_DIR = path.resolve(process.cwd(), "local-data/address-db-poc");

const REGIONS = [
  "busan",
  "chungbuk",
  "chungnam",
  "daegu",
  "daejeon",
  "gangwon",
  "gyeongbuk",
  "gyeongnam",
  "gyunggi",
  "incheon",
  "jeju",
  "jeonbuk",
  "jeonnamgwangju",
  "sejong",
  "seoul",
  "ulsan",
];

const PY_STREAM_SCRIPT = `
import sys, zipfile, subprocess, codecs
mode, archive, entry = sys.argv[1], sys.argv[2], sys.argv[3]
out = sys.stdout.buffer
dec = codecs.getincrementaldecoder("cp949")("replace")
CHUNK = 1024 * 1024
if mode == "zip":
    with zipfile.ZipFile(archive, "r") as zf:
        with zf.open(entry) as f:
            while True:
                b = f.read(CHUNK)
                if not b:
                    break
                out.write(dec.decode(b, False).encode("utf-8"))
            tail = dec.decode(b"", True)
            if tail:
                out.write(tail.encode("utf-8"))
elif mode == "7z":
    p = subprocess.Popen(["tar", "-xOf", archive, "--fast-read", entry], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    while True:
        b = p.stdout.read(CHUNK)
        if not b:
            break
        out.write(dec.decode(b, False).encode("utf-8"))
    tail = dec.decode(b"", True)
    if tail:
        out.write(tail.encode("utf-8"))
    rc = p.wait()
    if rc != 0:
        sys.stderr.write(p.stderr.read().decode("utf-8", errors="replace"))
        sys.exit(rc)
out.flush()
`;

async function streamArchiveLines(
  archiveType: "zip" | "7z",
  archivePath: string,
  entryName: string,
  onLine: (line: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "python",
      ["-u", "-c", PY_STREAM_SCRIPT, archiveType, archivePath, entryName],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString("utf-8");
    });
    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });
    rl.on("line", (line) => {
      if (line.length > 0) onLine(line);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `Stream failed (${archiveType} ${entryName}, code=${code}): ${stderr}`
          )
        );
    });
  });
}

function loadEnvLocal(): Record<string, string> {
  const env: Record<string, string> = {};
  const envPath = path.resolve(process.cwd(), ".env.local");
  if (!fs.existsSync(envPath)) return env;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const k = trimmed.slice(0, eq).trim();
    const v = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .replace(/^'(.*)'$/, "$1");
    env[k] = v;
  }
  return env;
}

async function fetchLocalSupabasePublicRestrooms(): Promise<
  Array<Record<string, any>>
> {
  const env = loadEnvLocal();
  const baseUrl = (
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    env.NEXT_PUBLIC_SUPABASE_URL ||
    ""
  ).trim();
  const key = (
    process.env.SUPABASE_SECRET_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    env.SUPABASE_SECRET_KEY ||
    env.SUPABASE_SERVICE_ROLE_KEY ||
    ""
  ).trim();

  if (!baseUrl || !key) {
    throw new Error("Missing local Supabase credentials in .env.local");
  }
  const host = new URL(baseUrl).hostname.toLowerCase();
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error(
      `Safety block: refusing non-local Supabase URL (${host}) in read-only PoC`
    );
  }

  const rows: Array<Record<string, any>> = [];
  const PAGE = 1000;
  let offset = 0;
  while (true) {
    const url = `${baseUrl.replace(/\/$/, "")}/rest/v1/restrooms?select=id,source_record_id,name,road_address,address_detail,latitude,longitude,coordinate_source,coordinate_source_record_id,publication_status&type=eq.public&order=id.asc&offset=${offset}&limit=${PAGE}`;
    const res = await fetch(url, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
    });
    if (!res.ok) {
      throw new Error(`Local Supabase read failed: HTTP ${res.status}`);
    }
    const batch = (await res.json()) as Array<Record<string, any>>;
    if (!batch || batch.length === 0) break;
    rows.push(...batch);
    if (batch.length < PAGE) break;
    offset += PAGE;
  }
  return rows;
}

function sha256File(filePath: string): string {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(filePath, "r");
  const buf = Buffer.allocUnsafe(8 * 1024 * 1024);
  try {
    while (true) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

function csvEscape(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function runInventory(): void {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const pyCode = `
import zipfile, json
with zipfile.ZipFile(r"${SUMMARY_ZIP_PATH}", "r") as zf:
    bad = zf.testzip()
    items = []
    for info in zf.infolist():
        name = info.filename
        if not (info.flag_bits & 0x800):
            try: name = info.filename.encode("cp437").decode("cp949")
            except Exception: pass
        items.append({
            "name": name,
            "compressed_bytes": info.compress_size,
            "uncompressed_bytes": info.file_size,
            "crc": hex(info.CRC)
        })
    print(json.dumps({"bad_member": bad, "items": items}, ensure_ascii=False))
`;
  const zipRes = spawnSync("python", ["-c", pyCode], { encoding: "utf8" });
  if (zipRes.status !== 0) {
    throw new Error(`ZIP inventory failed: ${zipRes.stderr}`);
  }
  const zipInfo = JSON.parse(zipRes.stdout);

  const tarRes = spawnSync("tar", ["-tvf", NAV_7Z_PATH], { encoding: "utf8" });
  if (tarRes.status !== 0) {
    throw new Error(`7z inventory failed: ${tarRes.stderr}`);
  }
  const navItems = tarRes.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const m = line.match(
        /^\S+\s+\S+\s+\S+\s+\S+\s+(\d+)\s+(\S+\s+\S+\s+\S+)\s+(.+)$/
      );
      if (!m) return { raw: line };
      const rawName = m[3].trim();
      const name = rawName.endsWith(".pdf")
        ? "[가이드]내비게이션용DB 활용방법.pdf"
        : rawName;
      return {
        name,
        uncompressed_bytes: Number.parseInt(m[1], 10),
        mtime_raw: m[2].trim(),
      };
    });

  const zipStat = fs.statSync(SUMMARY_ZIP_PATH);
  const navStat = fs.statSync(NAV_7Z_PATH);

  const inventory = {
    generatedAt: new Date().toISOString(),
    tools: {
      sevenZipCliInstalled: false,
      py7zrInstalled: false,
      bsdtarVersion:
        spawnSync("tar", ["--version"], { encoding: "utf8" }).stdout.trim(),
      pythonVersion:
        spawnSync("python", ["--version"], { encoding: "utf8" }).stdout.trim(),
      nodeVersion: process.version,
    },
    archives: [
      {
        label: "위치정보요약DB_전체분",
        path: "local-data/202610_위치정보요약DB_전체분.zip",
        size_bytes: zipStat.size,
        sha256: sha256File(SUMMARY_ZIP_PATH),
        integrity_check:
          zipInfo.bad_member === null ? "PASS (testzip=None)" : `FAIL (${zipInfo.bad_member})`,
        file_count: zipInfo.items.length,
        total_uncompressed_bytes: zipInfo.items.reduce(
          (acc: number, i: any) => acc + (i.uncompressed_bytes || 0),
          0
        ),
        encoding: "CP949 (pipe '|' delimited, no header row)",
        files: zipInfo.items,
      },
      {
        label: "내비게이션용DB_전체분",
        path: "local-data/202610_내비게이션용DB_전체분.7z",
        size_bytes: navStat.size,
        sha256: sha256File(NAV_7Z_PATH),
        integrity_check: "PASS (bsdtar -tvf exit=0 & streaming verified)",
        file_count: navItems.length,
        total_uncompressed_bytes: navItems.reduce(
          (acc: number, i: any) => acc + (i.uncompressed_bytes || 0),
          0
        ),
        encoding: "CP949 (pipe '|' delimited, no header row)",
        files: navItems,
      },
    ],
  };

  const outPath = path.join(OUT_DIR, "source_inventory.json");
  fs.writeFileSync(outPath, JSON.stringify(inventory, null, 2), "utf8");
  console.log(`Saved inventory: ${outPath}`);
}

function classifySuwonExceptions(
  target: RestroomTarget,
  sumRes: SummaryMatchResult,
  combRes: CombinedMatchResult
): string[] {
  const tags: string[] = [];
  if (/공원|호수|산책|생태|저수지|천변|광장|주차장/i.test(target.name)) {
    tags.push("park_or_open_space");
  }
  if (/백화점|마트|아울렛|터미널|역|병원|구청|시청|도서관|박물관|경기장|대학교|복지관|센터/i.test(target.name)) {
    tags.push("large_building_or_complex");
  }
  const pRoad = parseRoadAddress(target.roadAddress);
  const pJibun = parseJibunAddress(target.jibunAddress);
  if (!pRoad && pJibun) {
    tags.push("jibun_only_in_road_field");
  }
  if (combRes.buildingCount > 1) {
    tags.push("multi_building_address");
  }
  if (combRes.auxEntranceCount > 0) {
    tags.push("has_aux_entrances");
  }
  if (
    sumRes.distanceMeters !== null &&
    sumRes.distanceMeters > 100
  ) {
    tags.push("summary_dist_gt_100m");
  }
  if (
    combRes.serviceDistanceMeters !== null &&
    combRes.serviceDistanceMeters > 100
  ) {
    tags.push("combined_dist_gt_100m");
  }
  return tags;
}

async function runSuwon(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const t0 = Date.now();
  const rawExport = JSON.parse(fs.readFileSync(SUWON_EXPORT_PATH, "utf8"));
  const exportRestrooms: Array<Record<string, any>> = rawExport.restrooms;

  const targets: RestroomTarget[] = exportRestrooms.map((r) => ({
    id: r.id,
    sourceRecordId: r.source_record_id ?? null,
    name: r.name,
    roadAddress: r.road_address ?? "",
    jibunAddress: r.address_detail ?? "",
    officialLat: typeof r.latitude === "number" ? r.latitude : null,
    officialLng: typeof r.longitude === "number" ? r.longitude : null,
    coordinateSource: r.coordinate_source ?? null,
    coordinateSourceRecordId: r.coordinate_source_record_id ?? null,
    sidoHint: "경기도",
  }));

  console.log(`Loaded ${targets.length} verified Suwon benchmark restrooms.`);

  const sumIdx = new SummaryAddressIndex();
  let sumSuwonRows = 0;
  await streamArchiveLines("zip", SUMMARY_ZIP_PATH, "entrc_gyunggi.txt", (line) => {
    const cols = line.split("|");
    if (!cols[4]?.includes("수원시")) return;
    sumSuwonRows += 1;
    const parsed = parseSummaryRow(cols);
    if (parsed) sumIdx.add(parsed);
  });
  console.log(`Indexed ${sumSuwonRows} Suwon rows from entrc_gyunggi.txt.`);

  const navIdx = new NavigationAddressIndex();
  let navBuildSuwon = 0;
  let navJibunSuwon = 0;
  let navAuxSuwon = 0;

  await streamArchiveLines("7z", NAV_7Z_PATH, "match_build_gyunggi.txt", (line) => {
    const cols = line.split("|");
    if (!cols[2]?.includes("수원시")) return;
    navBuildSuwon += 1;
    const parsed = parseNavBuildRow(cols);
    if (parsed) navIdx.addBuild(parsed);
  });
  await streamArchiveLines("7z", NAV_7Z_PATH, "match_jibun_gyunggi.txt", (line) => {
    const cols = line.split("|");
    if (!cols[2]?.includes("수원시")) return;
    navJibunSuwon += 1;
    const parsed = parseNavJibunRow(cols);
    if (parsed) navIdx.addJibun(parsed);
  });
  await streamArchiveLines("7z", NAV_7Z_PATH, "match_rs_entrc.txt", (line) => {
    const cols = line.split("|");
    if (!cols[0]?.startsWith("4111")) return;
    navAuxSuwon += 1;
    const parsed = parseNavAuxEntranceRow(cols);
    if (parsed) navIdx.addAuxEntrance(parsed);
  });
  console.log(
    `Indexed Navigation DB Suwon: builds=${navBuildSuwon}, jibuns=${navJibunSuwon}, aux=${navAuxSuwon}`
  );

  const summaryResults: SummaryMatchResult[] = [];
  const combinedResults: CombinedMatchResult[] = [];

  for (const t of targets) {
    summaryResults.push(matchRestroomSummaryOnly(t, sumIdx));
    combinedResults.push(matchRestroomCombined(t, sumIdx, navIdx));
  }

  // Write suwon_summary_only.csv
  const sumCsvLines = [
    [
      "restroom_id",
      "source_record_id",
      "name",
      "road_address",
      "jibun_address",
      "official_lat",
      "official_lng",
      "status",
      "match_basis",
      "candidate_count",
      "matched_road_key",
      "matched_building_name",
      "matched_lat",
      "matched_lng",
      "distance_meters",
    ].join(","),
  ];
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const r = summaryResults[i];
    sumCsvLines.push(
      [
        t.id,
        t.sourceRecordId,
        t.name,
        t.roadAddress,
        t.jibunAddress,
        t.officialLat,
        t.officialLng,
        r.status,
        r.matchBasis,
        r.candidateCount,
        r.matchedRoadKey,
        r.matchedBuildingName,
        r.matchedLat,
        r.matchedLng,
        r.distanceMeters !== null ? r.distanceMeters.toFixed(2) : "",
      ]
        .map(csvEscape)
        .join(",")
    );
  }
  fs.writeFileSync(
    path.join(OUT_DIR, "suwon_summary_only.csv"),
    "\uFEFF" + sumCsvLines.join("\n"),
    "utf8"
  );

  // Write suwon_combined.csv
  const combCsvLines = [
    [
      "restroom_id",
      "source_record_id",
      "name",
      "road_address",
      "jibun_address",
      "official_lat",
      "official_lng",
      "summary_status",
      "summary_distance_m",
      "combined_status",
      "combined_match_basis",
      "building_count",
      "aux_entrance_count",
      "matched_road_pk",
      "matched_building_mgmt_no",
      "matched_building_name",
      "service_coord_type",
      "service_lat",
      "service_lng",
      "service_distance_m",
      "centroid_pref_distance_m",
      "oracle_best_type",
      "oracle_best_distance_m",
      "exception_tags",
    ].join(","),
  ];
  const detailedItems: Array<Record<string, any>> = [];

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const s = summaryResults[i];
    const c = combinedResults[i];
    const tags = classifySuwonExceptions(t, s, c);
    combCsvLines.push(
      [
        t.id,
        t.sourceRecordId,
        t.name,
        t.roadAddress,
        t.jibunAddress,
        t.officialLat,
        t.officialLng,
        s.status,
        s.distanceMeters !== null ? s.distanceMeters.toFixed(2) : "",
        c.status,
        c.matchBasis,
        c.buildingCount,
        c.auxEntranceCount,
        c.matchedRoadPk,
        c.matchedBuildingMgmtNo,
        c.matchedBuildingName,
        c.serviceCoordType,
        c.serviceLat,
        c.serviceLng,
        c.serviceDistanceMeters !== null
          ? c.serviceDistanceMeters.toFixed(2)
          : "",
        c.centroidPrefDistanceMeters !== null
          ? c.centroidPrefDistanceMeters.toFixed(2)
          : "",
        c.oracleBestType,
        c.oracleBestDistanceMeters !== null
          ? c.oracleBestDistanceMeters.toFixed(2)
          : "",
        tags.join(";"),
      ]
        .map(csvEscape)
        .join(",")
    );
    detailedItems.push({
      id: t.id,
      sourceRecordId: t.sourceRecordId,
      name: t.name,
      roadAddress: t.roadAddress,
      jibunAddress: t.jibunAddress,
      officialLat: t.officialLat,
      officialLng: t.officialLng,
      summary: s,
      combined: c,
      tags,
    });
  }
  fs.writeFileSync(
    path.join(OUT_DIR, "suwon_combined.csv"),
    "\uFEFF" + combCsvLines.join("\n"),
    "utf8"
  );

  // Check duplicate addresses sharing same road_address or matchedRoadPk among the 502
  const byRoadAddr = new Map<string, string[]>();
  const byMatchedPk = new Map<string, string[]>();
  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const c = combinedResults[i];
    const pRoad = parseRoadAddress(t.roadAddress);
    if (pRoad) {
      const k = buildRoadKey(pRoad);
      const arr = byRoadAddr.get(k) ?? [];
      arr.push(t.name);
      byRoadAddr.set(k, arr);
    }
    if (c.matchedRoadPk) {
      const arr = byMatchedPk.get(c.matchedRoadPk) ?? [];
      arr.push(t.name);
      byMatchedPk.set(c.matchedRoadPk, arr);
    }
  }

  // Quantitative stats
  const countBy = (arr: Array<{ status: string }>, status: string) =>
    arr.filter((x) => x.status === status).length;

  const sumDistancesAll = summaryResults
    .filter((r) => r.status === "unique_match" && r.distanceMeters !== null)
    .map((r) => r.distanceMeters!);
  const combServiceDistancesAll = combinedResults
    .filter(
      (r) => r.status === "unique_match" && r.serviceDistanceMeters !== null
    )
    .map((r) => r.serviceDistanceMeters!);
  const combCentroidDistancesAll = combinedResults
    .filter(
      (r) =>
        r.status === "unique_match" && r.centroidPrefDistanceMeters !== null
    )
    .map((r) => r.centroidPrefDistanceMeters!);
  const combOracleDistancesAll = combinedResults
    .filter(
      (r) =>
        r.status === "unique_match" && r.oracleBestDistanceMeters !== null
    )
    .map((r) => r.oracleBestDistanceMeters!);

  // Common sample where BOTH summary and combined produced valid coordinates
  const commonIndices = targets
    .map((_, i) => i)
    .filter(
      (i) =>
        summaryResults[i].status === "unique_match" &&
        summaryResults[i].distanceMeters !== null &&
        combinedResults[i].status === "unique_match" &&
        combinedResults[i].serviceDistanceMeters !== null
    );

  // Additional matches unlocked by Navigation DB
  const newlyMatchedByNav = detailedItems.filter(
    (d) =>
      d.summary.status !== "unique_match" &&
      d.combined.status === "unique_match"
  );

  const metrics = {
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - t0,
    benchmarkCount: targets.length,
    summaryDb: {
      unique_match: countBy(summaryResults, "unique_match"),
      ambiguous_match: countBy(summaryResults, "ambiguous_match"),
      unmatched: countBy(summaryResults, "unmatched"),
      missing_address: countBy(summaryResults, "missing_address"),
      invalid_coordinate: countBy(summaryResults, "invalid_coordinate"),
      allMatchedDistanceStats: computeDistanceMetrics(sumDistancesAll),
    },
    combinedDb: {
      unique_match: countBy(combinedResults, "unique_match"),
      ambiguous_match: countBy(combinedResults, "ambiguous_match"),
      unmatched: countBy(combinedResults, "unmatched"),
      missing_address: countBy(combinedResults, "missing_address"),
      invalid_coordinate: countBy(combinedResults, "invalid_coordinate"),
      newlyMatchedCount: newlyMatchedByNav.length,
      newlyMatchedExamples: newlyMatchedByNav.map((d) => ({
        name: d.name,
        roadAddress: d.roadAddress,
        jibunAddress: d.jibunAddress,
        summaryStatus: d.summary.status,
        combinedBasis: d.combined.matchBasis,
        serviceDistM: d.combined.serviceDistanceMeters,
      })),
      serviceRuleEntranceFirstStats: computeDistanceMetrics(
        combServiceDistancesAll
      ),
      serviceRuleCentroidFirstStats: computeDistanceMetrics(
        combCentroidDistancesAll
      ),
      oracleReferenceBestStats: computeDistanceMetrics(combOracleDistancesAll),
    },
    commonSampleComparison: {
      count: commonIndices.length,
      summaryStats: computeDistanceMetrics(
        commonIndices.map((i) => summaryResults[i].distanceMeters!)
      ),
      combinedServiceEntranceFirstStats: computeDistanceMetrics(
        commonIndices.map((i) => combinedResults[i].serviceDistanceMeters!)
      ),
      combinedCentroidFirstStats: computeDistanceMetrics(
        commonIndices.map((i) => combinedResults[i].centroidPrefDistanceMeters!)
      ),
      oracleReferenceBestStats: computeDistanceMetrics(
        commonIndices.map((i) => combinedResults[i].oracleBestDistanceMeters!)
      ),
    },
    multiRestroomSameMatchedPk: Array.from(byMatchedPk.entries())
      .filter(([, names]) => names.length > 1)
      .map(([pk, names]) => ({ pk, count: names.length, names })),
    unmatchedCombined: detailedItems
      .filter((d) => d.combined.status !== "unique_match")
      .map((d) => ({
        name: d.name,
        roadAddress: d.roadAddress,
        jibunAddress: d.jibunAddress,
        summaryStatus: d.summary.status,
        combinedStatus: d.combined.status,
      })),
    largestErrorsTop20: [...detailedItems]
      .filter((d) => d.combined.serviceDistanceMeters !== null)
      .sort(
        (a, b) =>
          b.combined.serviceDistanceMeters - a.combined.serviceDistanceMeters
      )
      .slice(0, 20)
      .map((d) => ({
        name: d.name,
        roadAddress: d.roadAddress,
        jibunAddress: d.jibunAddress,
        summaryDistM: d.summary.distanceMeters,
        combinedServiceDistM: d.combined.serviceDistanceMeters,
        combinedCentroidDistM: d.combined.centroidPrefDistanceMeters,
        oracleBestDistM: d.combined.oracleBestDistanceMeters,
        oracleBestType: d.combined.oracleBestType,
        buildingCount: d.combined.buildingCount,
        auxEntranceCount: d.combined.auxEntranceCount,
        tags: d.tags,
      })),
    exceptionCounts: {
      parksAndOpenSpaces: detailedItems.filter((d) =>
        d.tags.includes("park_or_open_space")
      ).length,
      largeBuildings: detailedItems.filter((d) =>
        d.tags.includes("large_building_or_complex")
      ).length,
      jibunOnlyInRoadField: detailedItems.filter((d) =>
        d.tags.includes("jibun_only_in_road_field")
      ).length,
      multiBuildingAddress: detailedItems.filter((d) =>
        d.tags.includes("multi_building_address")
      ).length,
      hasAuxEntrances: detailedItems.filter((d) =>
        d.tags.includes("has_aux_entrances")
      ).length,
    },
  };

  fs.writeFileSync(
    path.join(OUT_DIR, "suwon_metrics.json"),
    JSON.stringify(metrics, null, 2),
    "utf8"
  );
  console.log(`Suwon PoC finished in ${Date.now() - t0}ms`);
  console.log(
    `Summary DB: unique=${metrics.summaryDb.unique_match}, ambiguous=${metrics.summaryDb.ambiguous_match}, unmatched=${metrics.summaryDb.unmatched}, invalid_coord=${metrics.summaryDb.invalid_coordinate}`
  );
  console.log(
    `Combined DB: unique=${metrics.combinedDb.unique_match}, ambiguous=${metrics.combinedDb.ambiguous_match}, unmatched=${metrics.combinedDb.unmatched}, invalid_coord=${metrics.combinedDb.invalid_coordinate}`
  );
  console.log(
    `Summary mean=${metrics.summaryDb.allMatchedDistanceStats.mean?.toFixed(2)}m, p50=${metrics.summaryDb.allMatchedDistanceStats.p50?.toFixed(2)}m, p95=${metrics.summaryDb.allMatchedDistanceStats.p95?.toFixed(2)}m`
  );
  console.log(
    `Combined (service) mean=${metrics.combinedDb.serviceRuleEntranceFirstStats.mean?.toFixed(2)}m, p50=${metrics.combinedDb.serviceRuleEntranceFirstStats.p50?.toFixed(2)}m, p95=${metrics.combinedDb.serviceRuleEntranceFirstStats.p95?.toFixed(2)}m`
  );
}

function addTargetKeysToSets(
  target: RestroomTarget,
  neededRoadKeys: Set<string>,
  neededJibunKeys: Set<string>
): void {
  const roadEmpty = isPlaceholderAddress(target.roadAddress);
  const jibunEmpty = isPlaceholderAddress(target.jibunAddress);
  const roadHints = !roadEmpty ? extractAddressHints(target.roadAddress) : {};
  const jibunHints = !jibunEmpty ? extractAddressHints(target.jibunAddress) : {};
  const hints = {
    sidoHint: target.sidoHint || roadHints.sidoHint || jibunHints.sidoHint,
    sigunguHint:
      target.sigunguHint || roadHints.sigunguHint || jibunHints.sigunguHint,
  };

  const pRoad = parseRoadAddress(target.roadAddress, hints);
  if (pRoad) {
    neededRoadKeys.add(buildRoadKey(pRoad, false));
    neededRoadKeys.add(buildRoadKey(pRoad, true));
  }
  const pJibun =
    parseJibunAddress(target.jibunAddress, hints) ??
    parseJibunAddress(target.roadAddress, hints);
  if (pJibun) {
    neededJibunKeys.add(buildJibunKey(pJibun, false));
    neededJibunKeys.add(buildJibunKey(pJibun, true));
    if (!pJibun.ri) {
      const ld = stripAdminDongNumber(pJibun.dong);
      if (ld) {
        neededJibunKeys.add(buildJibunKey({ ...pJibun, dong: ld }, false));
      }
    }
  }
}

const SIDO_TO_REGION: Record<string, string> = {
  서울특별시: "seoul",
  부산광역시: "busan",
  대구광역시: "daegu",
  인천광역시: "incheon",
  전남광주통합특별시: "jeonnamgwangju",
  대전광역시: "daejeon",
  울산광역시: "ulsan",
  세종특별자치시: "sejong",
  경기도: "gyunggi",
  강원특별자치도: "gangwon",
  충청북도: "chungbuk",
  충청남도: "chungnam",
  전북특별자치도: "jeonbuk",
  경상북도: "gyeongbuk",
  경상남도: "gyeongnam",
  제주특별자치도: "jeju",
};

function getSidoLabel(target: RestroomTarget): string {
  const rHints = !isPlaceholderAddress(target.roadAddress)
    ? extractAddressHints(target.roadAddress)
    : {};
  const jHints = !isPlaceholderAddress(target.jibunAddress)
    ? extractAddressHints(target.jibunAddress)
    : {};
  return rHints.sidoHint || jHints.sidoHint || "(시도미상/누락)";
}

interface DatasetAccumulator {
  label: string;
  total: number;
  validAddressCount: number;
  summaryOnly: Record<string, number>;
  combined: Record<string, number>;
  improvedByNav: number;
  pkFreq: Map<string, number>;
  nameAddrFreq: Map<string, number>;
  bySido: Record<
    string,
    {
      total: number;
      summaryUnique: number;
      combinedUnique: number;
      combinedAmbiguous: number;
      combinedUnmatched: number;
      combinedInvalidCoord: number;
    }
  >;
}

function createAccumulator(label: string): DatasetAccumulator {
  return {
    label,
    total: 0,
    validAddressCount: 0,
    summaryOnly: {
      unique_match: 0,
      ambiguous_match: 0,
      unmatched: 0,
      missing_address: 0,
      invalid_coordinate: 0,
    },
    combined: {
      unique_match: 0,
      ambiguous_match: 0,
      unmatched: 0,
      missing_address: 0,
      invalid_coordinate: 0,
    },
    improvedByNav: 0,
    pkFreq: new Map<string, number>(),
    nameAddrFreq: new Map<string, number>(),
    bySido: {},
  };
}

function accumulateTarget(
  acc: DatasetAccumulator,
  t: RestroomTarget,
  sumIdx: SummaryAddressIndex,
  navIdx: NavigationAddressIndex
): void {
  acc.total += 1;
  const hasAddr =
    !isPlaceholderAddress(t.roadAddress) ||
    !isPlaceholderAddress(t.jibunAddress);
  if (hasAddr) acc.validAddressCount += 1;

  const s = matchRestroomSummaryOnly(t, sumIdx);
  const c = matchRestroomCombined(t, sumIdx, navIdx);
  acc.summaryOnly[s.status] += 1;
  acc.combined[c.status] += 1;

  if (s.status !== "unique_match" && c.status === "unique_match") {
    acc.improvedByNav += 1;
  }

  const sido = getSidoLabel(t);
  if (!acc.bySido[sido]) {
    acc.bySido[sido] = {
      total: 0,
      summaryUnique: 0,
      combinedUnique: 0,
      combinedAmbiguous: 0,
      combinedUnmatched: 0,
      combinedInvalidCoord: 0,
    };
  }
  acc.bySido[sido].total += 1;
  if (s.status === "unique_match") acc.bySido[sido].summaryUnique += 1;
  if (c.status === "unique_match") acc.bySido[sido].combinedUnique += 1;
  if (c.status === "ambiguous_match") acc.bySido[sido].combinedAmbiguous += 1;
  if (c.status === "unmatched") acc.bySido[sido].combinedUnmatched += 1;
  if (c.status === "invalid_coordinate")
    acc.bySido[sido].combinedInvalidCoord += 1;

  if (c.matchedRoadPk) {
    acc.pkFreq.set(c.matchedRoadPk, (acc.pkFreq.get(c.matchedRoadPk) ?? 0) + 1);
  }
  const naKey = `${t.name.replace(/\s+/g, "").toLowerCase()}|${(t.roadAddress || t.jibunAddress).replace(/\s+/g, "")}`;
  acc.nameAddrFreq.set(naKey, (acc.nameAddrFreq.get(naKey) ?? 0) + 1);
}

function finalizeAccumulator(acc: DatasetAccumulator) {
  const sharedAddressGroups = Array.from(acc.pkFreq.values()).filter(
    (v) => v > 1
  ).length;
  const sharedAddressRows = Array.from(acc.pkFreq.values())
    .filter((v) => v > 1)
    .reduce((a, b) => a + b, 0);
  const dupNameAddrGroups = Array.from(acc.nameAddrFreq.values()).filter(
    (v) => v > 1
  ).length;
  const dupNameAddrRows = Array.from(acc.nameAddrFreq.values())
    .filter((v) => v > 1)
    .reduce((a, b) => a + b, 0);

  return {
    label: acc.label,
    total: acc.total,
    validAddressCount: acc.validAddressCount,
    summaryOnly: acc.summaryOnly,
    combined: acc.combined,
    improvedByNav: acc.improvedByNav,
    sharedRoadPkGroups: sharedAddressGroups,
    sharedRoadPkRecords: sharedAddressRows,
    duplicateNameAndAddressGroups: dupNameAddrGroups,
    duplicateNameAndAddressRecords: dupNameAddrRows,
    bySido: acc.bySido,
  };
}

async function runNationwide(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const t0 = Date.now();

  // 1) Load local Supabase 51,260 rows (read-only)
  const dbRaw = await fetchLocalSupabasePublicRestrooms();
  const dbTargets: RestroomTarget[] = dbRaw.map((r) => ({
    id: r.id,
    sourceRecordId: r.source_record_id ?? null,
    name: r.name,
    roadAddress: r.road_address ?? "",
    jibunAddress: (r.address_detail || "").startsWith("(지번)")
      ? r.address_detail
      : "",
    officialLat: typeof r.latitude === "number" ? r.latitude : null,
    officialLng: typeof r.longitude === "number" ? r.longitude : null,
    coordinateSource: r.coordinate_source ?? null,
  }));

  // 2) Load raw CSV 53,584 rows
  const csvBuf = fs.readFileSync(RAW_CSV_PATH);
  const csvText = decodeCsvBuffer(csvBuf, "auto");
  const csvRaw = parseCsv(csvText);
  const csvTargets: RestroomTarget[] = csvRaw.map((r, idx) => ({
    id: `csv-${idx + 1}`,
    sourceRecordId: (r["관리번호"] || "").trim() || null,
    name: (r["화장실명"] || "").trim(),
    roadAddress: (r["소재지도로명주소"] || "").trim(),
    jibunAddress: (r["소재지지번주소"] || "").trim(),
    officialLat: null,
    officialLng: null,
  }));

  console.log(
    `Loaded nationwide targets: localDB=${dbTargets.length}, rawCSV=${csvTargets.length}`
  );

  // Bucket targets by region so each region's address index can be freed immediately after evaluation
  const dbByReg = new Map<string, RestroomTarget[]>();
  const csvByReg = new Map<string, RestroomTarget[]>();
  for (const reg of REGIONS) {
    dbByReg.set(reg, []);
    csvByReg.set(reg, []);
  }
  const dbUnknown: RestroomTarget[] = [];
  const csvUnknown: RestroomTarget[] = [];

  for (const t of dbTargets) {
    const reg = SIDO_TO_REGION[getSidoLabel(t)];
    if (reg) dbByReg.get(reg)!.push(t);
    else dbUnknown.push(t);
  }
  for (const t of csvTargets) {
    const reg = SIDO_TO_REGION[getSidoLabel(t)];
    if (reg) csvByReg.get(reg)!.push(t);
    else csvUnknown.push(t);
  }

  const navStats: Record<string, any> = {
    matchBuild: { totalRows: 0, missingCentroid: 0, missingEntrance: 0, badCols: 0, perFile: [] },
    matchJibun: { totalRows: 0, seq0Count: 0, sanCount: 0, badCols: 0, perFile: [] },
    matchRsEntrc: { totalRows: 0, missingXy: 0, badCols: 0, byType: {} as Record<string, number> },
  };

  // Load tiny match_rs_entrc.txt (12,846 rows) once
  const auxAll: Array<NonNullable<ReturnType<typeof parseNavAuxEntranceRow>>> = [];
  await streamArchiveLines("7z", NAV_7Z_PATH, "match_rs_entrc.txt", (line) => {
    navStats.matchRsEntrc.totalRows += 1;
    const cols = line.split("|");
    if (cols.length !== 11) {
      navStats.matchRsEntrc.badCols += 1;
      return;
    }
    const et = cols[7].trim();
    navStats.matchRsEntrc.byType[et] = (navStats.matchRsEntrc.byType[et] ?? 0) + 1;
    if (!cols[8].trim() || !cols[9].trim()) {
      navStats.matchRsEntrc.missingXy += 1;
    }
    const entry = parseNavAuxEntranceRow(cols);
    if (entry) auxAll.push(entry);
  });

  const localAcc = createAccumulator("local_supabase_public_restrooms");
  const csvAcc = createAccumulator("public_restroom_raw_csv");
  let peakRssBytes = process.memoryUsage().rss;

  // Evaluate unknown-sido targets directly against empty indexes
  const emptySum = new SummaryAddressIndex();
  const emptyNav = new NavigationAddressIndex();
  for (const t of dbUnknown) accumulateTarget(localAcc, t, emptySum, emptyNav);
  for (const t of csvUnknown) accumulateTarget(csvAcc, t, emptySum, emptyNav);

  // Process 16 regions one-by-one to keep RAM bounded
  for (const reg of REGIONS) {
    const regDb = dbByReg.get(reg)!;
    const regCsv = csvByReg.get(reg)!;
    const neededRoadKeys = new Set<string>();
    const neededJibunKeys = new Set<string>();
    for (const t of regDb) addTargetKeysToSets(t, neededRoadKeys, neededJibunKeys);
    for (const t of regCsv) addTargetKeysToSets(t, neededRoadKeys, neededJibunKeys);

    const sumIdx = new SummaryAddressIndex();
    const navIdx = new NavigationAddressIndex();
    const neededRoadPks = new Set<string>();

    const entrcFile = `entrc_${reg}.txt`;
    let eCount = 0;
    await streamArchiveLines("zip", SUMMARY_ZIP_PATH, entrcFile, (line) => {
      eCount += 1;
      const cols = line.split("|");
      if (cols.length < 18) return;
      const sido = canonicalizeSido(cols[3]) || cols[3].trim();
      const sigungu = cols[4].trim();
      const roadName = cols[7].trim();
      const under = cols[8].trim() || "0";
      const mainNo = String(Number.parseInt(cols[9].trim() || "0", 10));
      const subNo = String(Number.parseInt(cols[10].trim() || "0", 10));
      const k1 = buildRoadKey({ sido, sigungu, roadName, underground: under, mainNo, subNo }, false);
      const k2 = buildRoadKey({ sido, sigungu, roadName, underground: under, mainNo, subNo }, true);
      if (neededRoadKeys.has(k1) || neededRoadKeys.has(k2)) {
        const entry = parseSummaryRow(cols);
        if (entry) sumIdx.add(entry);
      }
    });

    const jibunFile = `match_jibun_${reg}.txt`;
    let jCount = 0;
    let jSeq0 = 0;
    let jSan = 0;
    let jBad = 0;
    await streamArchiveLines("7z", NAV_7Z_PATH, jibunFile, (line) => {
      jCount += 1;
      const cols = line.split("|");
      if (cols.length !== 20) {
        jBad += 1;
        return;
      }
      if (cols[12] === "0") jSeq0 += 1;
      if (cols[5] === "1") jSan += 1;
      const sido = canonicalizeSido(cols[1]) || cols[1].trim();
      const sigungu = cols[2].trim();
      const dong = cols[3].trim();
      const ri = cols[4].trim();
      const isSan = cols[5].trim() || "0";
      const lotMain = String(Number.parseInt(cols[6].trim() || "0", 10));
      const lotSub = String(Number.parseInt(cols[7].trim() || "0", 10));
      const jk1 = buildJibunKey({ sido, sigungu, dong, ri, isSan, mainNo: lotMain, subNo: lotSub }, false);
      const jk2 = buildJibunKey({ sido, sigungu, dong, ri, isSan, mainNo: lotMain, subNo: lotSub }, true);
      if (neededJibunKeys.has(jk1) || neededJibunKeys.has(jk2)) {
        const entry = parseNavJibunRow(cols);
        if (entry) {
          navIdx.addJibun(entry);
          neededRoadPks.add(
            `${entry.roadCode}|${entry.underground}|${entry.mainNo}|${entry.subNo}|${entry.addrEmdCode}`
          );
        }
      }
    });
    navStats.matchJibun.totalRows += jCount;
    navStats.matchJibun.seq0Count += jSeq0;
    navStats.matchJibun.sanCount += jSan;
    navStats.matchJibun.badCols += jBad;
    navStats.matchJibun.perFile.push({ file: jibunFile, rows: jCount, seq0: jSeq0, san: jSan });

    const buildFile = `match_build_${reg}.txt`;
    let bCount = 0;
    let bMissCent = 0;
    let bMissEnt = 0;
    let bBad = 0;
    await streamArchiveLines("7z", NAV_7Z_PATH, buildFile, (line) => {
      bCount += 1;
      const cols = line.split("|");
      if (cols.length !== 33) {
        bBad += 1;
        return;
      }
      if (!cols[23].trim() || !cols[24].trim()) bMissCent += 1;
      if (!cols[25].trim() || !cols[26].trim()) bMissEnt += 1;

      const sido = canonicalizeSido(cols[1]) || cols[1].trim();
      const sigungu = cols[2].trim();
      const roadName = cols[5].trim();
      const under = cols[6].trim() || "0";
      const mainNo = String(Number.parseInt(cols[7].trim() || "0", 10));
      const subNo = String(Number.parseInt(cols[8].trim() || "0", 10));
      const pk = `${cols[4].trim()}|${under}|${mainNo}|${subNo}|${cols[0].trim()}`;
      const k1 = buildRoadKey({ sido, sigungu, roadName, underground: under, mainNo, subNo }, false);
      const k2 = buildRoadKey({ sido, sigungu, roadName, underground: under, mainNo, subNo }, true);
      if (neededRoadKeys.has(k1) || neededRoadKeys.has(k2) || neededRoadPks.has(pk)) {
        const entry = parseNavBuildRow(cols);
        if (entry) {
          navIdx.addBuild(entry);
          neededRoadPks.add(pk);
        }
      }
    });
    navStats.matchBuild.totalRows += bCount;
    navStats.matchBuild.missingCentroid += bMissCent;
    navStats.matchBuild.missingEntrance += bMissEnt;
    navStats.matchBuild.badCols += bBad;
    navStats.matchBuild.perFile.push({
      file: buildFile,
      rows: bCount,
      missingCentroid: bMissCent,
      missingEntrance: bMissEnt,
    });

    for (const a of auxAll) {
      const pk = `${a.roadCode}|${a.underground}|${a.mainNo}|${a.subNo}|${a.bjdCode}`;
      if (neededRoadPks.has(pk)) navIdx.addAuxEntrance(a);
    }

    for (const t of regDb) accumulateTarget(localAcc, t, sumIdx, navIdx);
    for (const t of regCsv) accumulateTarget(csvAcc, t, sumIdx, navIdx);

    const curRss = process.memoryUsage().rss;
    if (curRss > peakRssBytes) peakRssBytes = curRss;
    console.log(
      `  [${reg}] targets(db=${regDb.length},csv=${regCsv.length}) entrc=${eCount}, jibun=${jCount}, build=${bCount} (${Math.round((Date.now() - t0) / 1000)}s, rss=${Math.round(curRss / 1024 / 1024)}MB)`
    );
  }

  const localDbEval = finalizeAccumulator(localAcc);
  const rawCsvEval = finalizeAccumulator(csvAcc);

  const mem = process.memoryUsage();
  const out = {
    generatedAt: new Date().toISOString(),
    elapsedSeconds: Number(((Date.now() - t0) / 1000).toFixed(2)),
    peakRssMb: Number((peakRssBytes / 1024 / 1024).toFixed(1)),
    heapUsedMb: Number((mem.heapUsed / 1024 / 1024).toFixed(1)),
    localDbEval,
    rawCsvEval,
  };

  fs.writeFileSync(
    path.join(OUT_DIR, "nav_db_stats.json"),
    JSON.stringify(navStats, null, 2),
    "utf8"
  );
  fs.writeFileSync(
    path.join(OUT_DIR, "nationwide_metrics.json"),
    JSON.stringify(out, null, 2),
    "utf8"
  );
  console.log(
    `Nationwide PoC completed in ${out.elapsedSeconds}s (peak RSS ${out.peakRssMb} MB)`
  );
  console.log(
    `Local DB (${localDbEval.total}): Summary unique=${localDbEval.summaryOnly.unique_match}, Combined unique=${localDbEval.combined.unique_match}`
  );
  console.log(
    `Raw CSV (${rawCsvEval.total}): Summary unique=${rawCsvEval.summaryOnly.unique_match}, Combined unique=${rawCsvEval.combined.unique_match}`
  );
}

async function main() {
  const args = process.argv.slice(2);
  const modeIdx = args.indexOf("--mode");
  const mode = modeIdx >= 0 ? args[modeIdx + 1] : "all";

  if (mode === "inventory" || mode === "all") {
    runInventory();
  }
  if (mode === "suwon" || mode === "all") {
    await runSuwon();
  }
  if (mode === "nationwide" || mode === "all") {
    await runNationwide();
  }
}

main().catch((err) => {
  console.error("PoC error:", err);
  process.exit(1);
});
