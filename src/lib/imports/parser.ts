import crypto from "node:crypto";
import type { RawPublicRestroomRecord, ParsedPublicRestroom } from "./types";

export type CsvEncoding = "auto" | "utf8" | "cp949";

/**
 * Decodes raw CSV buffer supporting UTF-8 and CP949 (EUC-KR / Windows-949).
 * In "auto" mode, validates strict UTF-8 first and falls back to CP949.
 */
export function decodeCsvBuffer(
  buffer: Buffer | Uint8Array,
  encoding: CsvEncoding = "auto"
): string {
  if (encoding === "utf8") {
    return new TextDecoder("utf-8").decode(buffer);
  }
  if (encoding === "cp949") {
    return new TextDecoder("euc-kr").decode(buffer);
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return new TextDecoder("euc-kr").decode(buffer);
  }
}

/**
 * Standard RFC 4180 compliant CSV Parser
 * Handles escaped quotes, commas inside quotes, CRLF/LF line breaks.
 */
export function parseCsv(csvText: string): RawPublicRestroomRecord[] {
  const cleanText = csvText.replace(/^\uFEFF/, ""); // Remove BOM if present
  const lines = splitCsvRows(cleanText);
  if (lines.length === 0) return [];

  const headers = lines[0].map((h) => h.trim());
  const records: RawPublicRestroomRecord[] = [];

  for (let i = 1; i < lines.length; i++) {
    const row = lines[i];
    if (row.length === 1 && row[0].trim() === "") continue; // Skip empty trailing lines

    const record: RawPublicRestroomRecord = {};
    for (let j = 0; j < headers.length; j++) {
      const key = headers[j];
      const val = row[j] !== undefined ? row[j].trim() : "";
      record[key] = val;
    }
    records.push(record);
  }

  return records;
}

/**
 * Splits raw CSV content into array of rows, where each row is an array of cells.
 */
function splitCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentCell = "";
  let insideQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const nextChar = text[i + 1];

    if (char === '"') {
      if (insideQuotes && nextChar === '"') {
        currentCell += '"';
        i++; // Skip escaped quote
      } else {
        insideQuotes = !insideQuotes;
      }
    } else if (char === "," && !insideQuotes) {
      currentRow.push(currentCell);
      currentCell = "";
    } else if ((char === "\r" || char === "\n") && !insideQuotes) {
      if (char === "\r" && nextChar === "\n") {
        i++; // Skip \n in CRLF
      }
      currentRow.push(currentCell);
      rows.push(currentRow);
      currentRow = [];
      currentCell = "";
    } else {
      currentCell += char;
    }
  }

  if (currentCell !== "" || currentRow.length > 0) {
    currentRow.push(currentCell);
    rows.push(currentRow);
  }

  return rows;
}

/**
 * Parses and normalizes a single raw public restroom record.
 * Quarantines unlocated records as 'draft'.
 */
export function normalizeRecord(
  raw: RawPublicRestroomRecord,
  index: number,
  options?: { cityFilter?: string | null }
): { parsed?: ParsedPublicRestroom; error?: string; skipped?: boolean } {
  const name = (raw["화장실명"] || "").trim();
  if (!name) {
    return { error: `라인 ${index + 2}: 필수 필드 '화장실명'이 누락되었습니다.` };
  }

  // Address: Prefer road address, fallback to jibun address
  const roadAddress = (raw["소재지도로명주소"] || "").trim();
  const jibunAddress = (raw["소재지지번주소"] || "").trim();
  const address = roadAddress || jibunAddress;
  if (!address) {
    return { error: `라인 ${index + 2} (${name}): 도로명주소 및 지번주소가 모두 누락되었습니다.` };
  }

  // Regional city filter (e.g., '수원', '수원시') to isolate target city from national dataset
  // Note: Only the physical address (road or jibun) determines location.
  // Agency alone (e.g. 수원시청-managed facility located outside Suwon) must not qualify a toilet in another city.
  const agency = (raw["관리기관명"] || "").trim();
  if (options?.cityFilter) {
    const filter = options.cityFilter.trim();
    const inAddress = roadAddress.includes(filter) || jibunAddress.includes(filter);
    if (!inAddress) {
      return { skipped: true };
    }
  }

  // Source Record ID (Normalized hash fallback if explicit ID is missing)
  const explicitId = (raw["화장실관리번호"] || raw["관리번호"] || raw["연번"] || "").trim();
  const normalizedKey = `${name.replace(/\s+/g, "")}::${address.replace(/\s+/g, "")}`;
  const sourceRecordId =
    explicitId ||
    `SUWON-GEN-${crypto
      .createHash("sha256")
      .update(normalizedKey)
      .digest("hex")
      .slice(0, 16)}`;

  // Coordinates validation
  const rawLatStr = (raw["WGS84위도"] || raw["위도"] || "").trim();
  const rawLngStr = (raw["WGS84경도"] || raw["경도"] || "").trim();
  const parsedLat = rawLatStr ? parseFloat(rawLatStr) : NaN;
  const parsedLng = rawLngStr ? parseFloat(rawLngStr) : NaN;

  let latitude: number | null = null;
  let longitude: number | null = null;
  let publicationStatus: "published" | "draft" = "draft";

  const isValidLat = !isNaN(parsedLat) && parsedLat >= -90 && parsedLat <= 90;
  const isValidLng = !isNaN(parsedLng) && parsedLng >= -180 && parsedLng <= 180;

  // Additional sanity check: Korea peninsula latitude (approx 33~39), longitude (approx 124~132)
  if (isValidLat && isValidLng && parsedLat > 30 && parsedLat < 45 && parsedLng > 120 && parsedLng < 135) {
    latitude = parsedLat;
    longitude = parsedLng;
    publicationStatus = "published";
  } else {
    // Quarantine invalid/missing coordinates as draft
    latitude = null;
    longitude = null;
    publicationStatus = "draft";
  }

  // Gender Type
  const unisexRaw = (raw["남녀공용화장실여부"] || "").trim().toUpperCase();
  let genderType: "male" | "female" | "separate" | "unisex" | "unknown" = "unknown";
  if (unisexRaw === "Y") {
    genderType = "unisex";
  } else if (unisexRaw === "N") {
    genderType = "separate";
  }

  // Accessibility flags
  const maleDisabledStall = parseInt(raw["남성용-장애인용대변기수"] || "0", 10);
  const femaleDisabledStall = parseInt(raw["여성용-장애인용대변기수"] || "0", 10);
  const maleDisabledUrinal = parseInt(raw["남성용-장애인용소변기수"] || "0", 10);
  const wheelchairAccessible =
    !isNaN(maleDisabledStall) && !isNaN(femaleDisabledStall)
      ? maleDisabledStall > 0 || femaleDisabledStall > 0 || maleDisabledUrinal > 0
      : null;

  const babyChangingRaw = (raw["기저귀교환대유무"] || "").trim().toUpperCase();
  let babyChangingAvailable: boolean | null = null;
  if (babyChangingRaw === "Y") {
    babyChangingAvailable = true;
  } else if (babyChangingRaw === "N") {
    babyChangingAvailable = false;
  }

  // Description & metadata
  const openingHours = (raw["개방시간상세"] || raw["개방시간"] || "").trim();
  const phone = (raw["전화번호"] || "").trim();
  const descParts: string[] = [];
  if (openingHours) descParts.push(`개방시간: ${openingHours}`);
  if (agency) descParts.push(`관리: ${agency}`);
  if (phone) descParts.push(`연락처: ${phone}`);
  const description = descParts.length > 0 ? descParts.join(" / ") : null;

  // Last verified at (Protect against future timestamp SQLSTATE 22007)
  const baseDateRaw = (raw["데이터기준일자"] || "").trim();
  let lastVerifiedAt = new Date().toISOString();
  if (baseDateRaw) {
    const parsedDate = new Date(baseDateRaw);
    if (!isNaN(parsedDate.getTime())) {
      const now = new Date();
      // If date is in the future, cap to now
      if (parsedDate > now) {
        lastVerifiedAt = now.toISOString();
      } else {
        lastVerifiedAt = parsedDate.toISOString();
      }
    }
  }

  return {
    parsed: {
      sourceRecordId,
      name,
      description,
      roadAddress: address,
      addressDetail: jibunAddress && roadAddress !== jibunAddress ? `(지번) ${jibunAddress}` : null,
      latitude,
      longitude,
      genderType,
      wheelchairAccessible,
      babyChangingAvailable,
      sanitaryProductsAvailable: null,
      accessMethod: "open",
      publicationStatus,
      lastVerifiedAt,
      rawMetadata: raw,
    },
  };
}

