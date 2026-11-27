#!/usr/bin/env python3
"""
HujiMap TASK 2 Supplement Pipeline
- Audits and excludes Wave 2 rows failing facility-level coordinate or current-existence criteria:
  * kex_highway_rest_area_toilet (201): locationinfoRest is rest-area representative coord
  * mof_beach_toilet (152): 15147562 (2014) is beach representative coord
  * knps_national_park_toilet (334 of 494): EXT-* (2), temp/mobile/simple (158), uncorroborated 2012-2014 (174); keeps 160 permanently corroborated
- Validates and loads newly collected OpenAPI datasets (plus Daejeon Seogu direct portal APIs):
  * 15070795 Busan Haeundae-gu
  * 15158504 Daejeon Metro
  * 15112469 Daejeon Seo-gu Public
  * 15108145 Daejeon Seo-gu Open
  * 15143265 Gyeongbuk Public Toilets
  * 15125108 KMTI Forest Trail Toilets
- Documents held/unavailable APIs (15098328 Sejong, 15095582 Chungju, 15085372 Goesan, 15008891 Uiryeong, 15074680 Jeonnam).
- Outputs idempotent SQL batches under local-data/nationwide_sql_batches_wave2_supplement/
  and local-data/nationwide_expand_wave2_supplement_summary.json.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import re
import uuid
from collections import Counter, defaultdict
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SUP_DATA_DIR = os.path.join(ROOT, "local-data", "official-datasets", "wave2_supplement")
ADMIN_REGIONS_TS = os.path.join(ROOT, "src", "lib", "restrooms", "korea-admin-regions.ts")
NAT_RAW_CSV = os.path.join(ROOT, "local-data", "public_restroom_raw.csv")
SQL_OUT_DIR = os.path.join(ROOT, "local-data", "nationwide_sql_batches_wave2_supplement")
SUMMARY_OUT = os.path.join(ROOT, "local-data", "nationwide_expand_wave2_supplement_summary.json")

TEMP_OR_CLOSED_RE = re.compile(
    r"폐쇄|철거|공사중|임시폐쇄|운영중지|폐지|철수|미사용|사용불가|사용중지|임시휴관|휴관중|"
    r"임시|이동식|이동화장실|미개방|출입제한|거주자|모바일",
    re.IGNORECASE,
)
PRIVATE_OWNERSHIP_RE = re.compile(r"민간|개인|법인|사설|기업|사유")
RESTRICTED_OR_PRIVATE_NAME_RE = re.compile(
    r"초등학교|중학교|고등학교|대학교|학교|유치원|어린이집|경로당|노인정|아파트|주상복합|"
    r"오피스텔|빌라|사옥|공장|물류센터|창고|군부대|교도소|구치소|요양원|요양병원|"
    r"사찰|교회|성당|골프장|리조트|콘도|호텔|모텔|게스트하우스|식당|카페|가든|"
    r"농원|산장|주유소|충전소|㈜|주식회사|병원|의원|약국|치과|한의원|은행|농협|수협|신협|새마을금고|빌딩|프라자|사우나",
    re.IGNORECASE,
)
PUBLIC_FACILITY_HINT_RE = re.compile(
    r"공원|시장|광장|역사|지하철역|철도역|터미널|해수욕장|해변|체육관|문화센터|복지관|"
    r"주민센터|행정복지센터|구청|시청|도청|군청|면사무소|읍사무소|동사무소|도서관|"
    r"박물관|미술관|주차장|하천|강변|관광|생태|숲|오름|포구|공영|공중화장실|개방화장실|휴게소|국립공원|운동장|체육|보건소|청사|쉼터|우체국",
    re.IGNORECASE,
)

REGIONAL_BBOX = {
    "부산": (34.85, 35.40, 128.75, 129.35),
    "대전": (36.15, 36.52, 127.22, 127.58),
    "경북": (35.40, 37.60, 127.70, 131.90),
}


def deterministic_uuid(namespace_key: str) -> str:
    digest = hashlib.sha256(namespace_key.encode("utf-8")).digest()
    b = bytearray(digest[:16])
    b[6] = (b[6] & 0x0F) | 0x40
    b[8] = (b[8] & 0x3F) | 0x80
    return str(uuid.UUID(bytes=bytes(b)))


def norm_text(s: Optional[str]) -> str:
    if not s:
        return ""
    return re.sub(r"[^0-9a-zA-Z가-힣]", "", s).lower()


def norm_sido(s: Optional[str]) -> str:
    if not s:
        return ""
    s = s.strip()
    mapping = [
        ("서울", "서울특별시"), ("부산", "부산광역시"), ("대구", "대구광역시"),
        ("인천", "인천광역시"), ("대전", "대전광역시"), ("울산", "울산광역시"),
        ("세종", "세종특별자치시"), ("경기", "경기도"), ("강원", "강원특별자치도"),
        ("충북", "충청북도"), ("충청북", "충청북도"), ("충남", "충청남도"), ("충청남", "충청남도"),
        ("전북", "전북특별자치도"), ("전라북", "전북특별자치도"),
        ("전남", "전라남도"), ("전라남", "전라남도"), ("전남광주", "전라남도"),
        ("경북", "경상북도"), ("경상북", "경상북도"), ("경남", "경상남도"), ("경상남", "경상남도"),
        ("제주", "제주특별자치도"),
    ]
    for pref, canon in mapping:
        if s.startswith(pref):
            return canon
    if s.startswith("광주") and "경기" not in s:
        return "광주광역시"
    return s


def extract_sido_from_address(addr: Optional[str]) -> str:
    if not addr:
        return ""
    first = addr.strip().split()[0] if addr.strip() else ""
    ns = norm_sido(first)
    if ns in {
        "서울특별시", "부산광역시", "대구광역시", "인천광역시", "광주광역시",
        "대전광역시", "울산광역시", "세종특별자치시", "경기도", "강원특별자치도",
        "충청북도", "충청남도", "전북특별자치도", "전라남도", "경상북도", "경상남도", "제주특별자치도"
    }:
        return ns
    return ""


def norm_addr_core(s: Optional[str]) -> str:
    if not s:
        return ""
    s = re.sub(r"\([^)]*\)", "", s)
    for k, v in [
        ("서울특별시", "서울"), ("부산광역시", "부산"), ("대구광역시", "대구"),
        ("인천광역시", "인천"), ("광주광역시", "광주"), ("대전광역시", "대전"),
        ("울산광역시", "울산"), ("세종특별자치시", "세종"), ("제주특별자치도", "제주"),
        ("강원특별자치도", "강원"), ("강원도", "강원"), ("전북특별자치도", "전북"),
        ("전라북도", "전북"), ("전라남도", "전남"), ("경상북도", "경북"),
        ("경상남도", "경남"), ("충청북도", "충북"), ("충청남도", "충남"),
    ]:
        s = s.replace(k, v)
    return norm_text(s)


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2.0 * r * math.atan2(math.sqrt(a), math.sqrt(max(0.0, 1.0 - a)))


def is_valid_kr_coord(lat: float, lng: float, region_key: Optional[str] = None) -> bool:
    if not (math.isfinite(lat) and math.isfinite(lng)):
        return False
    if not (33.0 <= lat <= 38.9 and 124.5 <= lng <= 131.9):
        return False
    if region_key and region_key in REGIONAL_BBOX:
        min_lat, max_lat, min_lng, max_lng = REGIONAL_BBOX[region_key]
        if not (min_lat <= lat <= max_lat and min_lng <= lng <= max_lng):
            return False
    return True


def has_min_decimal_precision(raw_lat: str, raw_lng: str, min_dp: int = 4) -> bool:
    if not raw_lat or not raw_lng:
        return True
    if "." not in raw_lat or "." not in raw_lng:
        return False
    dp_lat = len(raw_lat.strip().split(".")[1])
    dp_lng = len(raw_lng.strip().split(".")[1])
    return min(dp_lat, dp_lng) >= min_dp


def load_admin_regions() -> List[Dict[str, Any]]:
    raw = open(ADMIN_REGIONS_TS, encoding="utf-8").read()
    start = raw.find("export const KOREA_ADMIN_REGIONS")
    eq_idx = raw.find("= [", start)
    bracket_start = raw.find("[", eq_idx)
    bracket_end = raw.find("];", bracket_start)
    arr_str = re.sub(r",(\s*[}\]])", r"\1", raw[bracket_start : bracket_end + 1])
    return json.loads(arr_str)


def resolve_admin_region(lat: float, lng: float, regions: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    matches = [
        r for r in regions
        if r["south"] <= lat <= r["north"] and r["west"] <= lng <= r["east"]
    ]
    if not matches:
        return min(
            regions,
            key=lambda r: ((r["south"] + r["north"]) / 2.0 - lat) ** 2 + ((r["west"] + r["east"]) / 2.0 - lng) ** 2,
        )
    return min(
        matches,
        key=lambda r: (
            (r["north"] - r["south"]) * (r["east"] - r["west"]),
            ((r["south"] + r["north"]) / 2.0 - lat) ** 2 + ((r["west"] + r["east"]) / 2.0 - lng) ** 2,
        ),
    )


def load_sb_json(path: str) -> List[Dict[str, Any]]:
    raw = open(path, "rb").read()
    txt = raw.decode("utf-16") if raw[:2] in (b"\xff\xfe", b"\xfe\xff") else raw.decode("utf-8-sig")
    return json.loads(txt[txt.find("{"):]).get("rows", [])


def read_csv_bytes(raw: bytes) -> List[List[str]]:
    for enc in ("utf-8-sig", "cp949", "euc-kr"):
        try:
            return list(csv.reader(raw.decode(enc).splitlines()))
        except Exception:
            pass
    return list(csv.reader(raw.decode("cp949", "replace").splitlines()))


def parse_bool_yn(val: Optional[str]) -> Optional[bool]:
    if not val:
        return None
    v = val.strip().upper()
    if v in ("Y", "1", "O", "YES", "TRUE", "있음", "설치"):
        return True
    if v in ("N", "0", "X", "NO", "FALSE", "없음", "미설치"):
        return False
    return None


def clean_open_hours(raw: Optional[str]) -> str:
    s = (raw or "").strip()
    if s in ("", "-", "~", ":~:", "00:00~00:00", "미상", "없음"):
        return ""
    return s


def clamp_iso_date(raw: Optional[str], fallback_date: str) -> str:
    s = (raw or "").strip()
    m = re.match(r"^(\d{4})[-.]?(\d{2})[-.]?(\d{2})", s)
    if not m:
        return f"{fallback_date}T00:00:00.000Z"
    ymd = f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
    if ymd > "2026-11-26":
        ymd = "2026-11-26"
    return f"{ymd}T00:00:00.000Z"


def is_restricted_or_private(
    name: str,
    ownership: str = "",
    ftype: str = "",
    open_hours: str = "",
    strict_private_name: bool = False,
) -> Optional[str]:
    text_all = f"{name} {ftype}"
    if TEMP_OR_CLOSED_RE.search(text_all):
        return "temp_or_closed"
    if PRIVATE_OWNERSHIP_RE.search(ownership):
        if "개방" not in ftype or not clean_open_hours(open_hours):
            return "open_private_unclear_access"
        if strict_private_name and RESTRICTED_OR_PRIVATE_NAME_RE.search(name) and not PUBLIC_FACILITY_HINT_RE.search(name):
            return "private_restricted_name"
    if RESTRICTED_OR_PRIVATE_NAME_RE.search(name) and not PUBLIC_FACILITY_HINT_RE.search(name):
        return "restricted_or_private_name"
    return None


def sql_str(v: Optional[str]) -> str:
    if v is None:
        return "NULL"
    return "'" + v.replace("'", "''") + "'"


def sql_bool(v: Optional[bool]) -> str:
    if v is None:
        return "NULL"
    return "true" if v else "false"


@dataclass
class SourceSpec:
    uuid: str
    provider: str
    dataset: str
    source_url: str
    license_name: str
    license_url: str
    attribution: str
    coordinate_source: str
    base_date: str


SOURCE_SPECS: Dict[str, SourceSpec] = {
    "busan_haeundae": SourceSpec(
        uuid="eeeeeeee-eeee-4eee-8eee-000000000201",
        provider="부산광역시 해운대구",
        dataset="부산광역시 해운대구_공중화장실 정보조회 서비스",
        source_url="https://www.data.go.kr/data/15070795/openapi.do",
        license_name="이용허락범위 제한 없음",
        license_url="https://www.data.go.kr/ugs/selectPortalPolicyView.do",
        attribution="출처: 부산광역시 해운대구 / 공공데이터포털(15070795)",
        coordinate_source="busan_district_public_toilet",
        base_date="2025-07-29",
    ),
    "daejeon_metro": SourceSpec(
        uuid="eeeeeeee-eeee-4eee-8eee-000000000202",
        provider="대전교통공사",
        dataset="대전교통공사_공중화장실정보 조회 서비스",
        source_url="https://www.data.go.kr/data/15158504/openapi.do",
        license_name="이용허락범위 제한 없음",
        license_url="https://www.data.go.kr/ugs/selectPortalPolicyView.do",
        attribution="출처: 대전교통공사 / 공공데이터포털(15158504)",
        coordinate_source="daejeon_public_toilet",
        base_date="2026-04-29",
    ),
    "daejeon_seogu_public": SourceSpec(
        uuid="eeeeeeee-eeee-4eee-8eee-000000000203",
        provider="대전광역시 서구",
        dataset="대전광역시 서구_공중화장실 현황",
        source_url="https://www.data.go.kr/data/15112469/openapi.do",
        license_name="이용허락범위 제한 없음",
        license_url="https://www.data.go.kr/ugs/selectPortalPolicyView.do",
        attribution="출처: 대전광역시 서구 / 공공데이터포털(15112469)·서구 데이터포털",
        coordinate_source="daejeon_public_toilet",
        base_date="2025-11-20",
    ),
    "daejeon_seogu_open": SourceSpec(
        uuid="eeeeeeee-eeee-4eee-8eee-000000000204",
        provider="대전광역시 서구",
        dataset="대전광역시 서구_개방화장실현황",
        source_url="https://www.data.go.kr/data/15108145/openapi.do",
        license_name="이용허락범위 제한 없음",
        license_url="https://www.data.go.kr/ugs/selectPortalPolicyView.do",
        attribution="출처: 대전광역시 서구 / 공공데이터포털(15108145)·서구 데이터포털",
        coordinate_source="daejeon_public_toilet",
        base_date="2026-05-18",
    ),
    "gyeongbuk_public": SourceSpec(
        uuid="eeeeeeee-eeee-4eee-8eee-000000000205",
        provider="경상북도",
        dataset="경상북도_공중화장실 정보 조회",
        source_url="https://www.data.go.kr/data/15143265/openapi.do",
        license_name="이용허락범위 제한 없음",
        license_url="https://www.data.go.kr/ugs/selectPortalPolicyView.do",
        attribution="출처: 경상북도 / 공공데이터포털(15143265)",
        coordinate_source="gyeongbuk_public_toilet",
        base_date="2025-12-31",
    ),
    "kmti_forest_trail": SourceSpec(
        uuid="eeeeeeee-eeee-4eee-8eee-000000000206",
        provider="한국등산트레킹지원센터",
        dataset="한국등산트레킹지원센터_숲길 편의시설 POI 정보 서비스 (TOILET)",
        source_url="https://www.data.go.kr/data/15125108/openapi.do",
        license_name="이용허락범위 제한 없음",
        license_url="https://www.data.go.kr/ugs/selectPortalPolicyView.do",
        attribution="출처: 한국등산트레킹지원센터 / 공공데이터포털(15125108)",
        coordinate_source="kmti_forest_trail_toilet",
        base_date="2026-11-26",
    ),
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--restrooms-json", default=os.path.join(ROOT, "local-data", "wave2_sup_remote_restrooms.json"))
    parser.add_argument("--candidates-json", default=os.path.join(ROOT, "local-data", "wave2_sup_remote_candidates.json"))
    parser.add_argument("--write-sql", action="store_true")
    args = parser.parse_args()

    regions = load_admin_regions()
    existing_restrooms = load_sb_json(args.restrooms_json)
    candidates = load_sb_json(args.candidates_json)

    cands_by_matched: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for c in candidates:
        if c.get("matched_restroom_id"):
            cands_by_matched[c["matched_restroom_id"]].append(c)

    # Load 2026 national raw CSV + 15125108 + 15143265 for KNPS corroboration
    ft_raw = json.load(open(os.path.join(SUP_DATA_DIR, "15125108_forest_toilet.json"), encoding="utf-8"))["items"]
    gb_raw = json.load(open(os.path.join(SUP_DATA_DIR, "15143265_gyeongbuk.json"), encoding="utf-8"))["items"]

    ft_pts = []
    for x in ft_raw:
        try:
            ft_pts.append((float(x["lat"]), float(x["lot"])))
        except Exception:
            pass
    gb_pts = []
    for x in gb_raw:
        try:
            la, lo = float(x["latitude"]), float(x["longitude"])
            if 35.0 <= la <= 38.0 and 127.0 <= lo <= 132.0:
                gb_pts.append((la, lo))
        except Exception:
            pass

    nat_rows = read_csv_bytes(open(NAT_RAW_CSV, "rb").read())
    nat_by_core: Dict[str, List[Tuple[str, str, str]]] = defaultdict(list)
    for r in nat_rows[1:]:
        if len(r) > 30:
            nm = r[4].strip()
            core = re.sub(r"(공중화장실|개방화장실|화장실)$", "", norm_text(nm))
            if len(core) >= 2:
                nat_by_core[core].append((r[5].strip() or r[6].strip(), r[30].strip(), r[16].strip()))

    # ------------------------------------------------------------------------
    # 1. WAVE 2 QUALITY AUDIT & EXCLUSIONS (KEX 201, MOF 152, KNPS 334)
    # ------------------------------------------------------------------------
    exclude_rows: List[Tuple[str, str, str, str]] = []  # (id, new_coord_type, basis_tag, category)
    excluded_id_set: set[str] = set()
    knps_audit_counts: Counter = Counter()

    for r in existing_restrooms:
        if r.get("publication_status") != "published":
            continue
        cs = r.get("coordinate_source")
        rid = r["id"]
        if cs == "kex_highway_rest_area_toilet":
            exclude_rows.append((rid, "complex_centroid_mean", "EXCLUDED_20261127=kex_locationinfoRest_is_facility_representative_coord", "kex_restarea"))
            excluded_id_set.add(rid)
        elif cs == "mof_beach_toilet":
            exclude_rows.append((rid, "complex_centroid_mean", "EXCLUDED_20261127=mof_15147562_is_2014_beach_representative_coord", "mof_beach"))
            excluded_id_set.add(rid)
        elif cs == "knps_national_park_toilet":
            srec = r.get("source_record_id") or ""
            nm = r.get("name") or ""
            if srec.startswith("EXT-"):
                exclude_rows.append((rid, "manual", "EXCLUDED_20261127=knps_15136179_etc_structure_or_bench", "knps_ext"))
                excluded_id_set.add(rid)
                knps_audit_counts["excluded_ext_non_toilet"] += 1
                continue
            if any(k in nm for k in ("간이", "이동식", "임시", "모바일")):
                exclude_rows.append((rid, "facility_official", "EXCLUDED_20261127=knps_2012_temp_or_portable_unverified", "knps_temp"))
                excluded_id_set.add(rid)
                knps_audit_counts["excluded_temp_portable"] += 1
                continue
            if srec.startswith("PG-"):
                exclude_rows.append((rid, "building_centroid", "EXCLUDED_20261127=knps_2014_polygon_uncorroborated", "knps_pg_uncorr"))
                excluded_id_set.add(rid)
                knps_audit_counts["excluded_pg_uncorroborated"] += 1
                continue
            lat, lng = float(r["latitude"]), float(r["longitude"])
            corroborated = bool(cands_by_matched.get(rid))
            if not corroborated and any(haversine_m(lat, lng, fla, flo) <= 100.0 for fla, flo in ft_pts):
                corroborated = True
            if not corroborated and any(haversine_m(lat, lng, gla, glo) <= 100.0 for gla, glo in gb_pts):
                corroborated = True
            if not corroborated:
                core = re.sub(r"(공중화장실|개방화장실|화장실\(남자\)|화장실\(여자\)|화장실\d*|화장실)$", "", norm_text(nm))
                sido2 = (r.get("road_address") or "")[:2]
                sigungu = (r.get("road_address") or "").split()[1][:2] if len((r.get("road_address") or "").split()) >= 2 else ""
                if len(core) >= 3 and core in nat_by_core:
                    for naddr, _, norg in nat_by_core[core]:
                        if (sido2 and sido2 in naddr and (not sigungu or sigungu in naddr)) or "국립공원" in norg:
                            corroborated = True
                            break
            if not corroborated:
                exclude_rows.append((rid, "facility_official", "EXCLUDED_20261127=knps_2012_uncorroborated_existence", "knps_pt_uncorr"))
                excluded_id_set.add(rid)
                knps_audit_counts["excluded_pt_uncorroborated"] += 1
            else:
                knps_audit_counts["kept_permanent_corroborated"] += 1

    reverted_candidate_ids = [
        c["id"]
        for c in candidates
        if c.get("coordinate_status") == "official_matched" and c.get("matched_restroom_id") in excluded_id_set
    ]

    # ------------------------------------------------------------------------
    # 2. SPATIAL + CANDIDATE INDEXES (EXCLUDING ARCHIVED ROWS)
    # ------------------------------------------------------------------------
    spatial_grid: Dict[Tuple[int, int], List[Tuple[float, float]]] = {}
    existing_name_addr: set[Tuple[str, str]] = set()
    for r in existing_restrooms:
        if r["id"] in excluded_id_set or r.get("publication_status") != "published":
            continue
        lat, lng = r.get("latitude"), r.get("longitude")
        if lat is not None and lng is not None:
            spatial_grid.setdefault((int(float(lat) * 1000), int(float(lng) * 1000)), []).append((float(lat), float(lng)))
        na = norm_addr_core(r.get("road_address") or r.get("address_detail"))
        nn = norm_text(r.get("name"))
        if nn and na:
            existing_name_addr.add((nn, na))

    def is_near_occupied(lat: float, lng: float, dist_m: float = 30.0) -> bool:
        gx, gy = int(lat * 1000), int(lng * 1000)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for elat, elng in spatial_grid.get((gx + dx, gy + dy), []):
                    if haversine_m(lat, lng, elat, elng) <= dist_m:
                        return True
        return False

    def mark_occupied(lat: float, lng: float, name: str, addr: str) -> None:
        spatial_grid.setdefault((int(lat * 1000), int(lng * 1000)), []).append((lat, lng))
        nn, na = norm_text(name), norm_addr_core(addr)
        if nn and na:
            existing_name_addr.add((nn, na))

    reverted_cand_set = set(reverted_candidate_ids)
    unloc_by_sido_name: Dict[Tuple[str, str], str] = {}
    unloc_by_sido_addr: Dict[Tuple[str, str], str] = {}
    unloc_by_sido_sigungu: Dict[Tuple[str, str], List[Tuple[str, str]]] = defaultdict(list)
    for c in candidates:
        if c.get("coordinate_status") == "unlocated" or c["id"] in reverted_cand_set:
            sido = norm_sido(c.get("sido_name"))
            cid = c["id"]
            cn = c.get("normalized_name") or norm_text(c.get("name"))
            if cn and (sido, cn) not in unloc_by_sido_name:
                unloc_by_sido_name[(sido, cn)] = cid
            for af in ("road_address", "jibun_address"):
                ca = norm_addr_core(c.get(af))
                if ca and len(ca) >= 8 and (sido, ca) not in unloc_by_sido_addr:
                    unloc_by_sido_addr[(sido, ca)] = cid
            sg = (c.get("sigungu_name") or "").strip()
            if cn and sg:
                unloc_by_sido_sigungu[(sido, sg)].append((cn, cid))

    accepted: List[Dict[str, Any]] = []
    seen_restroom_ids: set[str] = set()
    seen_source_rec_keys: set[Tuple[str, str]] = set()
    stats: Dict[str, Dict[str, int]] = defaultdict(lambda: defaultdict(int))
    matched_candidate_ids: Dict[str, str] = {}

    def process_candidate_rows(
        source_key: str,
        raw_items: List[Dict[str, Any]],
        region_bbox_key: Optional[str] = None,
        strict_private_name: bool = False,
        check_distinct_addr_collision: bool = False,
        allowed_sidos: Optional[set[str]] = None,
    ) -> None:
        spec = SOURCE_SPECS[source_key]
        coord_groups: Dict[Tuple[float, float], List[Dict[str, Any]]] = defaultdict(list)
        pre_filtered: List[Dict[str, Any]] = []
        for item in raw_items:
            stats[source_key]["raw"] += 1
            if item.get("pre_hold"):
                stats[source_key][f"hold_{item['pre_hold']}"] += 1
                continue
            lat, lng = item["lat"], item["lng"]
            if not is_valid_kr_coord(lat, lng, region_bbox_key):
                stats[source_key]["hold_invalid_coord"] += 1
                continue
            if not has_min_decimal_precision(item.get("raw_lat", ""), item.get("raw_lng", ""), 4):
                stats[source_key]["hold_low_precision_coord"] += 1
                continue
            hold = is_restricted_or_private(
                item["name"],
                item.get("ownership", ""),
                item.get("ftype", ""),
                item.get("open_hours", ""),
                strict_private_name=strict_private_name,
            )
            if hold:
                stats[source_key][f"hold_{hold}"] += 1
                continue
            reg = resolve_admin_region(lat, lng, regions)
            if allowed_sidos and reg and reg["sidoName"] not in allowed_sidos:
                stats[source_key]["hold_wrong_sido_coord"] += 1
                continue
            key5 = (round(lat, 5), round(lng, 5))
            coord_groups[key5].append(item)
            pre_filtered.append(item)

        collapsed_keys: set[Tuple[float, float]] = set()
        deduped_local: List[Dict[str, Any]] = []
        for item in pre_filtered:
            key5 = (round(item["lat"], 5), round(item["lng"], 5))
            grp = coord_groups[key5]
            if len(grp) >= 2:
                if key5 in collapsed_keys:
                    stats[source_key]["collapsed_shared_coord"] += 1
                    continue
                collapsed_keys.add(key5)
                if check_distinct_addr_collision:
                    addrs = {
                        norm_addr_core(x.get("road_address") or x.get("address_detail"))[:12]
                        for x in grp
                        if (x.get("road_address") or x.get("address_detail"))
                    }
                    if len(addrs) >= 2:
                        stats[source_key]["hold_shared_coord_distinct_addrs"] += len(grp)
                        continue
                if len(grp) <= 5:
                    rep = dict(grp[0])
                    rep["description"] = (
                        f"{rep['description']} (동일 위치 {len(grp)}개 시설 통합)"
                        if rep.get("description")
                        else f"동일 위치 {len(grp)}개 시설 통합"
                    )
                    deduped_local.append(rep)
                else:
                    stats[source_key]["hold_shared_coord_complex_copy"] += len(grp)
                continue
            deduped_local.append(item)

        for item in deduped_local:
            lat, lng = item["lat"], item["lng"]
            if is_near_occupied(lat, lng, 30.0):
                stats[source_key]["dedup_30m"] += 1
                continue
            na = norm_addr_core(item.get("road_address") or item.get("address_detail"))
            nn = norm_text(item["name"])
            if not item.get("skip_name_addr_dedup") and nn and na and (nn, na) in existing_name_addr:
                stats[source_key]["dedup_name_addr"] += 1
                continue

            rec_id = item["record_id"]
            if (spec.uuid, rec_id) in seen_source_rec_keys:
                rec_id = f"{rec_id}-DUP-{stats[source_key]['accepted'] + 1}"
            restroom_id = deterministic_uuid(f"wave2sup:{spec.uuid}:{rec_id}")
            while restroom_id in seen_restroom_ids:
                rec_id = f"{rec_id}-U"
                restroom_id = deterministic_uuid(f"wave2sup:{spec.uuid}:{rec_id}")
            seen_source_rec_keys.add((spec.uuid, rec_id))
            seen_restroom_ids.add(restroom_id)

            reg = resolve_admin_region(lat, lng, regions)
            road_clean = (item.get("road_address") or "").strip()
            if not road_clean:
                road_clean = f"{reg['sidoName']} {reg['sigunguName']}" if reg else spec.provider
            sido = extract_sido_from_address(road_clean or item.get("address_detail")) or (reg["sidoName"] if reg else "")
            sigungu = reg["sigunguName"] if reg else ""
            name_clean = (item.get("name") or "").strip() or f"{spec.provider} 공중화장실"

            row = {
                "id": restroom_id,
                "source_key": source_key,
                "source_id": spec.uuid,
                "source_record_id": rec_id,
                "coordinate_source": spec.coordinate_source,
                "coordinate_source_record_id": f"{source_key}-{rec_id}",
                "coordinate_source_version": spec.base_date,
                "name": name_clean,
                "description": item["description"],
                "road_address": road_clean,
                "address_detail": item.get("address_detail"),
                "latitude": round(lat, 7),
                "longitude": round(lng, 7),
                "floor": item.get("floor"),
                "entrance_instructions": item.get("entrance_instructions"),
                "gender_type": item.get("gender_type", "unknown"),
                "wheelchair_accessible": item.get("wheelchair_accessible"),
                "baby_changing_available": item.get("baby_changing_available"),
                "last_verified_at": item.get("last_verified_at") or f"{spec.base_date}T00:00:00.000Z",
                "sido": sido,
            }
            accepted.append(row)
            mark_occupied(lat, lng, name_clean, road_clean)
            stats[source_key]["accepted"] += 1

            # Candidate matching (strict same sido + exact or tight sigungu match)
            if sido:
                r_core = norm_text(re.sub(r"(공중화장실|개방화장실|화장실)$", "", name_clean))
                r_addr = norm_addr_core(road_clean)
                matched_cid = unloc_by_sido_name.get((sido, nn))
                if matched_cid and matched_cid in matched_candidate_ids:
                    matched_cid = None
                if not matched_cid and r_addr and len(r_addr) >= 8:
                    cand_a = unloc_by_sido_addr.get((sido, r_addr))
                    if cand_a and cand_a not in matched_candidate_ids:
                        matched_cid = cand_a
                if not matched_cid and len(r_core) >= 3 and sigungu:
                    for cn, cid in unloc_by_sido_sigungu.get((sido, sigungu), []):
                        if r_core in cn and cid not in matched_candidate_ids:
                            matched_cid = cid
                            break
                if matched_cid and matched_cid not in matched_candidate_ids:
                    matched_candidate_ids[matched_cid] = restroom_id
                    stats[source_key]["matched_candidates"] += 1

    # ------------------------------------------------------------------------
    # 3. PROCESS COLLECTED DATASETS
    # ------------------------------------------------------------------------
    # A. 15070795 Busan Haeundae-gu
    hd_raw = json.load(open(os.path.join(SUP_DATA_DIR, "15070795_haeundae.json"), encoding="utf-8"))["items"]
    items = []
    for idx_r, x in enumerate(hd_raw, 1):
        try:
            lat, lng = float(x["lat"]), float(x["lng"])
        except Exception:
            items.append({"pre_hold": "missing_coord", "lat": 0, "lng": 0, "name": x.get("toiletName", "")})
            continue
        nm = re.sub(r"\s*\([^)]*Public Toilet[^)]*\)", "", (x.get("toiletName") or "")).strip()
        raw_addr = re.sub(r"\s*\([^)]*[a-zA-Z][^)]*\)", "", (x.get("address") or "")).strip()
        road = raw_addr if raw_addr.startswith("부산") else f"부산광역시 해운대구 {raw_addr}".strip()
        desc = f"관리: {(x.get('charge') or '부산광역시 해운대구').strip()} / {SOURCE_SPECS['busan_haeundae'].attribution}"
        if x.get("tel"):
            desc = f"전화: {x['tel']} / {desc}"
        items.append({
            "record_id": f"HD-{idx_r}",
            "name": nm,
            "road_address": road,
            "lat": lat, "lng": lng,
            "ftype": "공중화장실",
            "description": desc,
        })
    process_candidate_rows("busan_haeundae", items, "부산")

    # B. 15158504 Daejeon Metro
    dj_raw = json.load(open(os.path.join(SUP_DATA_DIR, "15158504_daejeon_metro.json"), encoding="utf-8"))["items"]
    items = []
    for idx_r, x in enumerate(dj_raw, 1):
        try:
            lat, lng = float(x["latitude"]), float(x["longitude"])
        except Exception:
            items.append({"pre_hold": "missing_coord", "lat": 0, "lng": 0, "name": x.get("name", "")})
            continue
        unisex = parse_bool_yn(x.get("unisex"))
        wc = (int(x.get("menDisabledBowlNum") or 0) + int(x.get("menDisabledUrinalNum") or 0) + int(x.get("womenDisabledBowlNum") or 0)) > 0
        items.append({
            "record_id": f"DJM-{idx_r}",
            "name": f"{(x.get('name') or '').strip()} 공중화장실".replace("공중화장실 공중화장실", "공중화장실"),
            "road_address": (x.get("roadAddress") or x.get("jibunAddress") or "").strip(),
            "address_detail": f"(지번) {(x.get('jibunAddress') or '').strip()}" if x.get("jibunAddress") else None,
            "lat": lat, "lng": lng,
            "ftype": "개방화장실",
            "open_hours": "첫차~막차",
            "gender_type": "unisex" if unisex is True else ("separate" if unisex is False else "unknown"),
            "wheelchair_accessible": wc,
            "description": f"관리: {(x.get('manageOrg') or '대전교통공사').strip()} / 전화: {x.get('managePhone') or '-'} / {SOURCE_SPECS['daejeon_metro'].attribution}",
        })
    process_candidate_rows("daejeon_metro", items, "대전")

    # C. 15112469 Daejeon Seogu Public
    sg_pub_raw = json.load(open(os.path.join(SUP_DATA_DIR, "15112469_seogu_public.json"), encoding="utf-8"))["items"]
    items = []
    for idx_r, x in enumerate(sg_pub_raw, 1):
        try:
            lat, lng = float(x["la"]), float(x["lo"])
        except Exception:
            items.append({"pre_hold": "missing_coord", "lat": 0, "lng": 0, "name": x.get("toilet_nm", "")})
            continue
        unisex = parse_bool_yn(x.get("male_famale_wtrcls_qy"))
        wc = (int(x.get("male_disable_person_wtrcls_qy") or 0) + int(x.get("male_disable_person_uil_qy") or 0) + int(x.get("female_disable_person_wtrcls_qy") or 0)) > 0
        bc = None if not x.get("diaper_change_place") else (False if x.get("diaper_change_place") == "없음" else True)
        oh = clean_open_hours(x.get("opn_time"))
        road = (x.get("locplc_rdnmadr") or x.get("locplc_lnm") or "").strip()
        jibun = (x.get("locplc_lnm") or "").strip()
        items.append({
            "record_id": f"DJSGP-{idx_r}",
            "name": (x.get("toilet_nm") or "").strip(),
            "road_address": road,
            "address_detail": f"(지번) {jibun}" if jibun and jibun != road else None,
            "lat": lat, "lng": lng,
            "ownership": (x.get("toilet_posesn_se") or "").strip(),
            "ftype": (x.get("se") or "").strip(),
            "open_hours": oh,
            "gender_type": "unisex" if unisex is True else ("separate" if unisex is False else "unknown"),
            "wheelchair_accessible": wc,
            "baby_changing_available": bc,
            "last_verified_at": clamp_iso_date(x.get("data_stdr_de"), "2025-11-20"),
            "description": f"개방시간: {oh or '상시/기관확인'} / 관리: {(x.get('mgc_nm') or '대전광역시 서구').strip()} / {SOURCE_SPECS['daejeon_seogu_public'].attribution}",
        })
    process_candidate_rows("daejeon_seogu_public", items, "대전", strict_private_name=True)

    # D. 15108145 Daejeon Seogu Open (strictly exclude owner_nm & unclear private facilities)
    sg_open_raw = json.load(open(os.path.join(SUP_DATA_DIR, "15108145_seogu_open.json"), encoding="utf-8"))["items"]
    items = []
    for idx_r, x in enumerate(sg_open_raw, 1):
        try:
            lat, lng = float(x["la"]), float(x["lo"])
        except Exception:
            items.append({"pre_hold": "missing_coord", "lat": 0, "lng": 0, "name": x.get("buld_nm", "")})
            continue
        idsty = (x.get("idsty_nm") or "").strip()
        is_pub_idsty = idsty in ("복지시설", "전통시장", "체육시설")
        wc = (int(x.get("dpsn_male_tilt_wrcs_co") or 0) + int(x.get("dpsn_male_tilt_uil_co") or 0) + int(x.get("dpsn_fmle_tilt_co") or 0)) > 0
        road = (x.get("rn_adrs") or x.get("lnm_adrs") or "").strip()
        jibun = (x.get("lnm_adrs") or "").strip()
        items.append({
            "record_id": f"DJSGO-{x.get('sn') or idx_r}",
            "name": (x.get("buld_nm") or "").strip(),
            "road_address": road,
            "address_detail": f"(지번) {jibun}" if jibun and jibun != road else None,
            "lat": lat, "lng": lng,
            "ownership": "공공" if is_pub_idsty else "민간",
            "ftype": "개방화장실",
            "open_hours": "",
            "wheelchair_accessible": wc,
            "last_verified_at": clamp_iso_date(x.get("data_stdr_de"), "2026-05-18"),
            "description": f"유형: {idsty} / {SOURCE_SPECS['daejeon_seogu_open'].attribution}",
        })
    process_candidate_rows("daejeon_seogu_open", items, "대전", strict_private_name=True)

    # E. 15143265 Gyeongbuk Public Toilets
    items = []
    for idx_r, x in enumerate(gb_raw, 1):
        la_s, lo_s = str(x.get("latitude") or "").strip(), str(x.get("longitude") or "").strip()
        try:
            lat, lng = float(la_s), float(lo_s)
        except Exception:
            items.append({"pre_hold": "missing_coord", "lat": 0, "lng": 0, "name": x.get("name", "")})
            continue
        cate = (x.get("cate") or "").strip()
        if cate == "이동화장실":
            items.append({"pre_hold": "mobile_toilet", "lat": lat, "lng": lng, "name": x.get("name", "")})
            continue
        road = (x.get("roadaddr") or x.get("addr") or "").strip()
        jibun = (x.get("addr") or "").strip()
        oh = clean_open_hours(x.get("opentime"))
        wc = (int(x.get("mjdcount") or 0) + int(x.get("mjscount") or 0) + int(x.get("wjdcount") or 0)) > 0
        bc = parse_bool_yn(x.get("dyperyn"))
        items.append({
            "record_id": f"GB-{x.get('no') or idx_r}",
            "name": (x.get("name") or "").strip(),
            "road_address": road,
            "address_detail": f"(지번) {jibun}" if jibun and jibun != road else None,
            "lat": lat, "lng": lng,
            "raw_lat": la_s, "raw_lng": lo_s,
            "ownership": (x.get("useyn") or "").strip(),
            "ftype": cate,
            "open_hours": oh,
            "wheelchair_accessible": wc,
            "baby_changing_available": bc,
            "last_verified_at": clamp_iso_date(x.get("datatime"), "2025-12-31"),
            "description": f"개방시간: {oh or '확인필요'} / 관리: {(x.get('management') or '경상북도').strip()} / {SOURCE_SPECS['gyeongbuk_public'].attribution}",
        })
    process_candidate_rows(
        "gyeongbuk_public",
        items,
        "경북",
        strict_private_name=True,
        check_distinct_addr_collision=True,
        allowed_sidos={"경상북도", "대구광역시"},
    )

    # F. 15125108 KMTI Forest Trail Toilets
    items = []
    for idx_r, x in enumerate(ft_raw, 1):
        la_s, lo_s = str(x.get("lat") or "").strip(), str(x.get("lot") or "").strip()
        try:
            lat, lng = float(la_s), float(lo_s)
        except Exception:
            items.append({"pre_hold": "missing_coord", "lat": 0, "lng": 0, "name": x.get("plcNm", "")})
            continue
        raw_plc = (x.get("plcNm") or "").strip()
        fr = (x.get("frtrlNm") or "").strip()
        if any(k in raw_plc for k in ("간이", "간이회장", "사찰", "교회", "성당", "암자", "절", "민박", "식당", "카페")):
            items.append({"pre_hold": "simple_or_private_trail_toilet", "lat": lat, "lng": lng, "name": raw_plc})
            continue
        if "해우소" in raw_plc and any(raw_plc.startswith(p) or f"{p} " in raw_plc for p in ("호압사", "백천사", "자재암", "부석사")):
            items.append({"pre_hold": "temple_haewuso", "lat": lat, "lng": lng, "name": raw_plc})
            continue
        reg = resolve_admin_region(lat, lng, regions)
        full_nm = raw_plc if (fr and fr in raw_plc) else f"{fr} {raw_plc}".strip()
        rec_id = f"FT-{x.get('poiId') or x.get('no') or idx_r}"
        items.append({
            "record_id": rec_id,
            "name": full_nm,
            "road_address": f"{reg['sidoName']} {reg['sigunguName']} {fr} 숲길".strip() if reg else f"{fr} 숲길",
            "address_detail": f"(숲길 POI) {fr} / 해발 {x.get('aslAltide')}m" if x.get("aslAltide") else f"(숲길 POI) {fr}",
            "lat": lat, "lng": lng,
            "raw_lat": la_s, "raw_lng": lo_s,
            "ftype": "공중화장실",
            "skip_name_addr_dedup": True,
            "last_verified_at": clamp_iso_date(x.get("crtrDt"), "2026-11-26"),
            "description": f"숲길명: {fr} / {SOURCE_SPECS['kmti_forest_trail'].attribution}",
        })
    process_candidate_rows("kmti_forest_trail", items)

    by_sido = Counter(r["sido"] for r in accepted)
    by_src = Counter(r["coordinate_source"] for r in accepted)
    excluded_by_cat = Counter(cat for _, _, _, cat in exclude_rows)
    summary = {
        "wave2QualityExclusions": {
            "totalExcluded": len(exclude_rows),
            "byCategory": dict(excluded_by_cat),
            "knpsAuditCounts": dict(knps_audit_counts),
            "revertedCandidatesCount": len(reverted_candidate_ids),
        },
        "totalNewRestrooms": len(accepted),
        "candidateMatchesToMarkOfficial": len(matched_candidate_ids),
        "netPublicVisibleDelta": len(accepted) - len(exclude_rows),
        "netCandidateOfficialDelta": len(matched_candidate_ids) - len(reverted_candidate_ids),
        "bySido": dict(sorted(by_sido.items(), key=lambda x: -x[1])),
        "byCoordinateSource": dict(sorted(by_src.items(), key=lambda x: -x[1])),
        "perDatasetStats": {k: dict(v) for k, v in stats.items()},
        "heldOrUnavailableApis": {
            "15098328_sejong": {"collected": 76, "approved": 0, "held": 76, "reason": "API 응답에 위경도(la/lo) 미제공"},
            "15095582_chungju": {"collected": 45, "approved": 0, "held": 45, "reason": "시장 편의시설 중 화장실 항목 0건(자전거보관소·지원센터 등)"},
            "15085372_goesan": {"collected": 0, "approved": 0, "held": 0, "reason": "API 오류 resultCode=102 (SERVICE_KEY_CERTIFICATION_ERROR)"},
            "15008891_uiryeong": {"collected": 0, "approved": 0, "held": 0, "reason": "기관 서버(data.uiryeong.go.kr) HTTP 503 / Read Timeout"},
            "15074680_jeonnam": {"collected": 0, "approved": 0, "held": 0, "reason": "게이트웨이 returnReasonCode=04 (HTTP_ERROR)"},
        },
    }

    if args.write_sql:
        os.makedirs(SQL_OUT_DIR, exist_ok=True)
        for old in os.listdir(SQL_OUT_DIR):
            if old.endswith(".sql"):
                os.remove(os.path.join(SQL_OUT_DIR, old))

        # 00_wave2_quality_exclusions.sql
        excl_lines = ["BEGIN;"]
        if exclude_rows:
            excl_lines.append("UPDATE public.restrooms AS r")
            excl_lines.append("SET publication_status = 'archived',")
            excl_lines.append("    coordinate_type = v.new_coord_type,")
            excl_lines.append("    coordinate_verification_status = 'REVIEW_REQUIRED',")
            excl_lines.append("    coordinate_verification_basis = CASE")
            excl_lines.append("      WHEN coalesce(r.coordinate_verification_basis, '') LIKE '%' || v.basis_tag || '%' THEN r.coordinate_verification_basis")
            excl_lines.append("      ELSE coalesce(r.coordinate_verification_basis, '') || '|' || v.basis_tag")
            excl_lines.append("    END,")
            excl_lines.append("    updated_at = now()")
            excl_lines.append("FROM (VALUES")
            excl_lines.append(",\n".join(
                f"  ('{rid}'::uuid, {sql_str(ctype)}, {sql_str(basis)})"
                for rid, ctype, basis, _ in exclude_rows
            ))
            excl_lines.append(") AS v(id, new_coord_type, basis_tag)")
            excl_lines.append("WHERE r.id = v.id")
            excl_lines.append("  AND r.publication_status = 'published';")
            excl_lines.append("")
        if reverted_candidate_ids:
            excl_lines.append("UPDATE public.public_restroom_candidates AS c")
            excl_lines.append("SET coordinate_status = 'unlocated',")
            excl_lines.append("    matched_restroom_id = NULL,")
            excl_lines.append("    updated_at = now()")
            excl_lines.append("WHERE c.coordinate_status = 'official_matched'")
            excl_lines.append("  AND c.id IN (")
            excl_lines.append(",\n".join(f"    '{cid}'::uuid" for cid in reverted_candidate_ids))
            excl_lines.append("  );")
        excl_lines.append("COMMIT;")
        with open(os.path.join(SQL_OUT_DIR, "00_wave2_quality_exclusions.sql"), "w", encoding="utf-8") as f:
            f.write("\n".join(excl_lines) + "\n")

        # 01_wave2_sup_sources.sql
        src_lines = ["BEGIN;"]
        for spec in SOURCE_SPECS.values():
            src_lines.append(
                "INSERT INTO public.public_data_sources (\n"
                "  id, provider_name, dataset_name, source_url, license_name, license_url, attribution_text, last_synced_at\n"
                ") VALUES (\n"
                f"  '{spec.uuid}'::uuid,\n"
                f"  {sql_str(spec.provider)},\n"
                f"  {sql_str(spec.dataset)},\n"
                f"  {sql_str(spec.source_url)},\n"
                f"  {sql_str(spec.license_name)},\n"
                f"  {sql_str(spec.license_url)},\n"
                f"  {sql_str(spec.attribution)},\n"
                "  now()\n"
                ") ON CONFLICT (id) DO UPDATE SET\n"
                "  dataset_name = EXCLUDED.dataset_name,\n"
                "  source_url = EXCLUDED.source_url,\n"
                "  license_name = EXCLUDED.license_name,\n"
                "  license_url = EXCLUDED.license_url,\n"
                "  attribution_text = EXCLUDED.attribution_text,\n"
                "  last_synced_at = now();"
            )
        src_lines.append("COMMIT;")
        with open(os.path.join(SQL_OUT_DIR, "01_wave2_sup_sources.sql"), "w", encoding="utf-8") as f:
            f.write("\n".join(src_lines) + "\n")

        # 02_wave2_sup_official_NNN.sql
        batch_size = 250
        for b_idx in range(0, len(accepted), batch_size):
            chunk = accepted[b_idx : b_idx + batch_size]
            lines = [
                "BEGIN;",
                "INSERT INTO public.restrooms (",
                "  id, type, business_id, source_id, source_record_id,",
                "  coordinate_source, coordinate_source_id, coordinate_source_record_id,",
                "  coordinate_type, coordinate_verification_status, coordinate_verification_basis, coordinate_source_version,",
                "  name, description, road_address, address_detail, latitude, longitude,",
                "  floor, entrance_instructions, gender_type, wheelchair_accessible, baby_changing_available,",
                "  access_method, publication_status, last_verified_at",
                ") VALUES",
            ]
            vals = []
            pvals = []
            for r in chunk:
                basis = f"POLICY=OFFICIAL_SOURCE_VALIDATED|FIELD_VERIFIED=false|source={r['coordinate_source']}({r['coordinate_source_record_id']})"
                vals.append(
                    "(\n"
                    f"  '{r['id']}'::uuid,\n"
                    "  'public',\n"
                    "  NULL::uuid,\n"
                    f"  '{r['source_id']}'::uuid,\n"
                    f"  {sql_str(r['source_record_id'])},\n"
                    f"  {sql_str(r['coordinate_source'])},\n"
                    f"  '{r['source_id']}'::uuid,\n"
                    f"  {sql_str(r['coordinate_source_record_id'])},\n"
                    "  'facility_official',\n"
                    "  'VERIFIED',\n"
                    f"  {sql_str(basis)},\n"
                    f"  {sql_str(r['coordinate_source_version'])},\n"
                    f"  {sql_str(r['name'])},\n"
                    f"  {sql_str(r['description'])},\n"
                    f"  {sql_str(r['road_address'])},\n"
                    f"  {sql_str(r['address_detail'])},\n"
                    f"  {r['latitude']},\n"
                    f"  {r['longitude']},\n"
                    f"  {sql_str(r['floor'])},\n"
                    f"  {sql_str(r['entrance_instructions'])},\n"
                    f"  {sql_str(r['gender_type'])},\n"
                    f"  {sql_bool(r['wheelchair_accessible'])},\n"
                    f"  {sql_bool(r['baby_changing_available'])},\n"
                    "  'open',\n"
                    "  'published',\n"
                    f"  {sql_str(r['last_verified_at'])}::timestamptz\n"
                    ")"
                )
                pvals.append(
                    f"(\n  '{r['id']}'::uuid,\n  1,\n  'free',\n  0,\n  false,\n  NULL::integer,\n  0,\n  true,\n  now()\n)"
                )
            lines.append(",\n".join(vals))
            lines.append("ON CONFLICT (source_id, source_record_id) WHERE source_id IS NOT NULL AND source_record_id IS NOT NULL DO NOTHING;")
            lines.append("")
            lines.append("INSERT INTO public.restroom_access_policies (")
            lines.append("  restroom_id, version, access_mode, deposit_amount_krw, refund_eligible,")
            lines.append("  receipt_window_hours, min_purchase_krw, is_active, effective_from")
            lines.append(") SELECT v.restroom_id, v.version, v.access_mode, v.deposit_amount_krw, v.refund_eligible,")
            lines.append("  v.receipt_window_hours, v.min_purchase_krw, v.is_active, v.effective_from")
            lines.append("FROM (VALUES")
            lines.append(",\n".join(pvals))
            lines.append(") AS v(restroom_id, version, access_mode, deposit_amount_krw, refund_eligible, receipt_window_hours, min_purchase_krw, is_active, effective_from)")
            lines.append("WHERE EXISTS (SELECT 1 FROM public.restrooms r WHERE r.id = v.restroom_id)")
            lines.append("  AND NOT EXISTS (SELECT 1 FROM public.restroom_access_policies p WHERE p.restroom_id = v.restroom_id AND p.is_active = true)")
            lines.append("ON CONFLICT (restroom_id, version) DO NOTHING;")
            lines.append("COMMIT;")
            out_file = os.path.join(SQL_OUT_DIR, f"02_wave2_sup_official_{b_idx // batch_size:03d}.sql")
            with open(out_file, "w", encoding="utf-8") as f:
                f.write("\n".join(lines) + "\n")

        # 03_wave2_sup_candidate_updates.sql
        cand_pairs = list(matched_candidate_ids.items())
        if cand_pairs:
            lines = [
                "BEGIN;",
                "UPDATE public.public_restroom_candidates AS c",
                "SET coordinate_status = 'official_matched',",
                "    matched_restroom_id = v.restroom_id,",
                "    updated_at = now()",
                "FROM (VALUES",
            ]
            lines.append(",\n".join(f"  ('{cid}'::uuid, '{rid}'::uuid)" for cid, rid in cand_pairs))
            lines.append(") AS v(candidate_id, restroom_id)")
            lines.append("WHERE c.id = v.candidate_id")
            lines.append("  AND c.coordinate_status = 'unlocated'")
            lines.append("  AND EXISTS (SELECT 1 FROM public.restrooms r WHERE r.id = v.restroom_id);")
            lines.append("COMMIT;")
            with open(os.path.join(SQL_OUT_DIR, "03_wave2_sup_candidate_updates.sql"), "w", encoding="utf-8") as f:
                f.write("\n".join(lines) + "\n")

        with open(SUMMARY_OUT, "w", encoding="utf-8") as f:
            json.dump(summary, f, ensure_ascii=False, indent=2)

    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
