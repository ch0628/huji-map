#!/usr/bin/env node
/**
 * Streams MOIS Summary DB + Navigation DB once for the 51,260 local Supabase
 * public restrooms and caches per-record match details to
 * `local-data/address-db-poc/phase2/_cache_local_db_matches.jsonl`
 * so Phase 2 classification and DRY-RUN iterations are fast and deterministic.
 *
 * Strictly read-only on local Supabase (127.0.0.1/localhost only).
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import {
  SummaryAddressIndex,
  NavigationAddressIndex,
  parseSummaryRow,
  parseNavBuildRow,
  parseNavJibunRow,
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
  haversineMeters,
  type RestroomTarget,
} from "./lib";

const SUMMARY_ZIP_PATH = path.resolve(
  process.cwd(),
  "local-data/202610_위치정보요약DB_전체분.zip"
);
const NAV_7Z_PATH = path.resolve(
  process.cwd(),
  "local-data/202610_내비게이션용DB_전체분.7z"
);
const PHASE2_DIR = path.resolve(
  process.cwd(),
  "local-data/address-db-poc/phase2"
);
const CACHE_PATH = path.join(PHASE2_DIR, "_cache_local_db_matches.jsonl");

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
                if not b: break
                out.write(dec.decode(b, False).encode("utf-8"))
            tail = dec.decode(b"", True)
            if tail: out.write(tail.encode("utf-8"))
elif mode == "7z":
    p = subprocess.Popen(["tar", "-xOf", archive, "--fast-read", entry], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    while True:
        b = p.stdout.read(CHUNK)
        if not b: break
        out.write(dec.decode(b, False).encode("utf-8"))
    tail = dec.decode(b"", True)
    if tail: out.write(tail.encode("utf-8"))
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
      else reject(new Error(`Stream failed (${entryName}): ${stderr}`));
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

async function fetchLocalDbRestrooms(): Promise<Array<Record<string, any>>> {
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

  if (!baseUrl || !key) throw new Error("Missing local Supabase credentials");
  const host = new URL(baseUrl).hostname.toLowerCase();
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error(`Safety block: refusing non-local URL (${host})`);
  }

  const rows: Array<Record<string, any>> = [];
  const PAGE = 1000;
  let offset = 0;
  while (true) {
    const url = `${baseUrl.replace(/\/$/, "")}/rest/v1/restrooms?select=id,source_id,source_record_id,name,description,road_address,address_detail,latitude,longitude,coordinate_source,coordinate_source_id,coordinate_source_record_id,gender_type,wheelchair_accessible,baby_changing_available,sanitary_products_available,access_method,publication_status,last_verified_at&type=eq.public&order=id.asc&offset=${offset}&limit=${PAGE}`;
    const res = await fetch(url, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!res.ok) throw new Error(`Local read HTTP ${res.status}`);
    const batch = (await res.json()) as Array<Record<string, any>>;
    if (!batch || batch.length === 0) break;
    rows.push(...batch);
    if (batch.length < PAGE) break;
    offset += PAGE;
  }
  return rows;
}

function addKeys(
  target: RestroomTarget,
  neededRoadKeys: Set<string>,
  neededJibunKeys: Set<string>
): void {
  const rEmpty = isPlaceholderAddress(target.roadAddress);
  const jEmpty = isPlaceholderAddress(target.jibunAddress);
  const rh = !rEmpty ? extractAddressHints(target.roadAddress) : {};
  const jh = !jEmpty ? extractAddressHints(target.jibunAddress) : {};
  const hints = {
    sidoHint: rh.sidoHint || jh.sidoHint,
    sigunguHint: rh.sigunguHint || jh.sigunguHint,
  };
  const pr = parseRoadAddress(target.roadAddress, hints);
  if (pr) {
    neededRoadKeys.add(buildRoadKey(pr, false));
    neededRoadKeys.add(buildRoadKey(pr, true));
  }
  const pj =
    parseJibunAddress(target.jibunAddress, hints) ??
    parseJibunAddress(target.roadAddress, hints);
  if (pj) {
    neededJibunKeys.add(buildJibunKey(pj, false));
    neededJibunKeys.add(buildJibunKey(pj, true));
    if (!pj.ri) {
      const ld = stripAdminDongNumber(pj.dong);
      if (ld) neededJibunKeys.add(buildJibunKey({ ...pj, dong: ld }, false));
    }
  }
}

async function main() {
  fs.mkdirSync(PHASE2_DIR, { recursive: true });
  const t0 = Date.now();
  const rawRows = await fetchLocalDbRestrooms();
  console.log(`Loaded ${rawRows.length} local public restrooms (read-only).`);

  type EnrichedTarget = RestroomTarget & {
    raw: Record<string, any>;
    sido: string;
    sigungu: string;
  };

  const targetsByReg = new Map<string, EnrichedTarget[]>();
  for (const reg of REGIONS) targetsByReg.set(reg, []);
  const unknownTargets: EnrichedTarget[] = [];

  for (const r of rawRows) {
    const roadAddress = r.road_address ?? "";
    const jibunAddress = (r.address_detail || "").startsWith("(지번)")
      ? r.address_detail
      : "";
    const rh = !isPlaceholderAddress(roadAddress)
      ? extractAddressHints(roadAddress)
      : {};
    const jh = !isPlaceholderAddress(jibunAddress)
      ? extractAddressHints(jibunAddress)
      : {};
    const sido = rh.sidoHint || jh.sidoHint || "(시도미상/누락)";
    const sigungu = rh.sigunguHint || jh.sigunguHint || "(시군구미상)";
    const item: EnrichedTarget = {
      id: r.id,
      sourceRecordId: r.source_record_id ?? null,
      name: r.name,
      roadAddress,
      jibunAddress,
      officialLat: typeof r.latitude === "number" ? r.latitude : null,
      officialLng: typeof r.longitude === "number" ? r.longitude : null,
      coordinateSource: r.coordinate_source ?? null,
      coordinateSourceRecordId: r.coordinate_source_record_id ?? null,
      raw: r,
      sido,
      sigungu,
    };
    const reg = SIDO_TO_REGION[sido];
    if (reg) targetsByReg.get(reg)!.push(item);
    else unknownTargets.push(item);
  }

  const outStream = fs.createWriteStream(CACHE_PATH, { encoding: "utf8" });
  const emptySum = new SummaryAddressIndex();
  const emptyNav = new NavigationAddressIndex();

  let countUnique = 0;
  let countAmb = 0;
  let countUnm = 0;
  let countInv = 0;

  const writeRecord = (
    t: EnrichedTarget,
    sumIdx: SummaryAddressIndex,
    navIdx: NavigationAddressIndex
  ) => {
    const s = matchRestroomSummaryOnly(t, sumIdx);
    const c = matchRestroomCombined(t, sumIdx, navIdx);
    if (c.status === "unique_match") countUnique += 1;
    else if (c.status === "ambiguous_match") countAmb += 1;
    else if (c.status === "unmatched") countUnm += 1;
    else if (c.status === "invalid_coordinate") countInv += 1;

    // Extract single/complex centroid & entrance details from matched builds
    let navBuildingUse: string | null = null;
    let navIsComplex: boolean | null = null;
    let navSido: string | null = null;
    let navSigungu: string | null = null;
    let navAdminDong: string | null = null;
    let hasNavCentroid = false;
    let hasNavEntrance = false;
    if (c.matchedRoadPk) {
      const builds = navIdx.getBuildsForRoadPk(c.matchedRoadPk);
      if (builds.length > 0) {
        navSido = builds[0].sido || null;
        navSigungu = builds[0].sigungu || null;
        navAdminDong = builds[0].adminDongName || null;
        navBuildingUse = builds[0].buildingUse || null;
        navIsComplex = builds[0].buildingCount > 1;
        hasNavCentroid = builds.some((b) => b.centroidCoord !== null);
        hasNavEntrance = builds.some((b) => b.entranceCoord !== null);
      }
    }

    // Also compute distance between existing local DB coords (kakao or gg) and MOIS centroidPref
    const existingToCentroidDistM =
      t.officialLat !== null &&
      t.officialLng !== null &&
      c.centroidPrefLat !== null &&
      c.centroidPrefLng !== null
        ? haversineMeters(
            t.officialLat,
            t.officialLng,
            c.centroidPrefLat,
            c.centroidPrefLng
          )
        : null;

    const rec = {
      id: t.id,
      source_id: t.raw.source_id,
      source_record_id: t.sourceRecordId,
      name: t.name,
      road_address: t.roadAddress,
      address_detail: t.raw.address_detail ?? null,
      jibun_address: t.jibunAddress,
      description: t.raw.description ?? null,
      gender_type: t.raw.gender_type,
      wheelchair_accessible: t.raw.wheelchair_accessible,
      baby_changing_available: t.raw.baby_changing_available,
      sanitary_products_available: t.raw.sanitary_products_available,
      access_method: t.raw.access_method,
      publication_status: t.raw.publication_status,
      last_verified_at: t.raw.last_verified_at,
      existing_lat: t.officialLat,
      existing_lng: t.officialLng,
      existing_coord_source: t.coordinateSource,
      existing_coord_source_id: t.raw.coordinate_source_id ?? null,
      existing_coord_source_record_id: t.coordinateSourceRecordId ?? null,
      sido: navSido || t.sido,
      sigungu: navSigungu || t.sigungu,
      admin_dong: navAdminDong,
      summary_status: s.status,
      summary_lat: s.matchedLat,
      summary_lng: s.matchedLng,
      combined_status: c.status,
      combined_match_basis: c.matchBasis,
      building_count: c.buildingCount,
      matched_road_pk: c.matchedRoadPk,
      matched_building_mgmt_no: c.matchedBuildingMgmtNo,
      matched_building_name: c.matchedBuildingName,
      nav_building_use: navBuildingUse,
      nav_is_complex: navIsComplex,
      has_nav_centroid: hasNavCentroid,
      has_nav_entrance: hasNavEntrance,
      service_coord_type: c.serviceCoordType,
      service_lat: c.serviceLat,
      service_lng: c.serviceLng,
      centroid_pref_lat: c.centroidPrefLat,
      centroid_pref_lng: c.centroidPrefLng,
      existing_to_centroid_dist_m: existingToCentroidDistM,
    };
    outStream.write(JSON.stringify(rec) + "\n");
  };

  for (const t of unknownTargets) writeRecord(t, emptySum, emptyNav);

  for (const reg of REGIONS) {
    const regTargets = targetsByReg.get(reg)!;
    const neededRoadKeys = new Set<string>();
    const neededJibunKeys = new Set<string>();
    for (const t of regTargets) addKeys(t, neededRoadKeys, neededJibunKeys);

    const sumIdx = new SummaryAddressIndex();
    const navIdx = new NavigationAddressIndex();
    const neededRoadPks = new Set<string>();

    await streamArchiveLines(
      "zip",
      SUMMARY_ZIP_PATH,
      `entrc_${reg}.txt`,
      (line) => {
        const cols = line.split("|");
        if (cols.length < 18) return;
        const sido = canonicalizeSido(cols[3]) || cols[3].trim();
        const sigungu = cols[4].trim();
        const roadName = cols[7].trim();
        const under = cols[8].trim() || "0";
        const mainNo = String(Number.parseInt(cols[9].trim() || "0", 10));
        const subNo = String(Number.parseInt(cols[10].trim() || "0", 10));
        const k1 = buildRoadKey(
          { sido, sigungu, roadName, underground: under, mainNo, subNo },
          false
        );
        const k2 = buildRoadKey(
          { sido, sigungu, roadName, underground: under, mainNo, subNo },
          true
        );
        if (neededRoadKeys.has(k1) || neededRoadKeys.has(k2)) {
          const entry = parseSummaryRow(cols);
          if (entry) sumIdx.add(entry);
        }
      }
    );

    await streamArchiveLines(
      "7z",
      NAV_7Z_PATH,
      `match_jibun_${reg}.txt`,
      (line) => {
        const cols = line.split("|");
        if (cols.length !== 20) return;
        const sido = canonicalizeSido(cols[1]) || cols[1].trim();
        const sigungu = cols[2].trim();
        const dong = cols[3].trim();
        const ri = cols[4].trim();
        const isSan = cols[5].trim() || "0";
        const lotMain = String(Number.parseInt(cols[6].trim() || "0", 10));
        const lotSub = String(Number.parseInt(cols[7].trim() || "0", 10));
        const jk1 = buildJibunKey(
          { sido, sigungu, dong, ri, isSan, mainNo: lotMain, subNo: lotSub },
          false
        );
        const jk2 = buildJibunKey(
          { sido, sigungu, dong, ri, isSan, mainNo: lotMain, subNo: lotSub },
          true
        );
        if (neededJibunKeys.has(jk1) || neededJibunKeys.has(jk2)) {
          const entry = parseNavJibunRow(cols);
          if (entry) {
            navIdx.addJibun(entry);
            neededRoadPks.add(
              `${entry.roadCode}|${entry.underground}|${entry.mainNo}|${entry.subNo}|${entry.addrEmdCode}`
            );
          }
        }
      }
    );

    await streamArchiveLines(
      "7z",
      NAV_7Z_PATH,
      `match_build_${reg}.txt`,
      (line) => {
        const cols = line.split("|");
        if (cols.length !== 33) return;
        const sido = canonicalizeSido(cols[1]) || cols[1].trim();
        const sigungu = cols[2].trim();
        const roadName = cols[5].trim();
        const under = cols[6].trim() || "0";
        const mainNo = String(Number.parseInt(cols[7].trim() || "0", 10));
        const subNo = String(Number.parseInt(cols[8].trim() || "0", 10));
        const pk = `${cols[4].trim()}|${under}|${mainNo}|${subNo}|${cols[0].trim()}`;
        const k1 = buildRoadKey(
          { sido, sigungu, roadName, underground: under, mainNo, subNo },
          false
        );
        const k2 = buildRoadKey(
          { sido, sigungu, roadName, underground: under, mainNo, subNo },
          true
        );
        if (
          neededRoadKeys.has(k1) ||
          neededRoadKeys.has(k2) ||
          neededRoadPks.has(pk)
        ) {
          const entry = parseNavBuildRow(cols);
          if (entry) {
            navIdx.addBuild(entry);
            neededRoadPks.add(pk);
          }
        }
      }
    );

    for (const t of regTargets) writeRecord(t, sumIdx, navIdx);
    console.log(
      `  [${reg}] cached ${regTargets.length} records (${Math.round((Date.now() - t0) / 1000)}s)`
    );
  }

  await new Promise<void>((res, rej) => {
    outStream.on("finish", res);
    outStream.on("error", rej);
    outStream.end();
  });

  console.log(
    `Cache written: ${CACHE_PATH} | unique=${countUnique}, amb=${countAmb}, unm=${countUnm}, inv=${countInv}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
