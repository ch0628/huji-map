#!/usr/bin/env python3
"""
HujiMap Wave 2 Official Restroom Coordinate Expansion Pipeline

Reads verified, legally redistributable (이용허락범위 제한 없음 / 공공데이터법 자유이용)
datasets archived in local-data/official-datasets/wave2/, applies Wave 1 strict
validation/filtering/deduplication rules, resolves region labels for park/bike-trail
records, writes idempotent SQL batches under local-data/nationwide_sql_batches_wave2/,
and outputs local-data/nationwide_expand_wave2_summary.json.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import os
import re
import struct
import sys
import uuid
import zipfile
from collections import Counter, defaultdict
from dataclasses import dataclass
from typing import Any, Dict, Iterable, List, Optional, Tuple

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
W2_DATA_DIR = os.path.join(ROOT, "local-data", "official-datasets", "wave2")
W1_DATA_DIR = os.path.join(ROOT, "local-data", "official-datasets")
ADMIN_REGIONS_TS = os.path.join(ROOT, "src", "lib", "restrooms", "korea-admin-regions.ts")
SQL_OUT_DIR = os.path.join(ROOT, "local-data", "nationwide_sql_batches_wave2")
SUMMARY_OUT = os.path.join(ROOT, "local-data", "nationwide_expand_wave2_summary.json")

TEMP_OR_CLOSED_RE = re.compile(
    r"폐쇄|철거|공사중|임시폐쇄|운영중지|폐지|철수|미사용|사용불가|사용중지|임시휴관|휴관중",
    re.IGNORECASE,
)
PRIVATE_OWNERSHIP_RE = re.compile(r"민간|개인|법인|사설|기업|사유")
RESTRICTED_OR_PRIVATE_NAME_RE = re.compile(
    r"초등학교|중학교|고등학교|대학교|학교|유치원|어린이집|경로당|노인정|아파트|주상복합|"
    r"오피스텔|빌라|사옥|공장|물류센터|창고|군부대|교도소|구치소|요양원|요양병원|"
    r"사찰|교회|성당|골프장|리조트|콘도|호텔|모텔|게스트하우스|식당|카페|가든|"
    r"농원|산장|주유소|충전소|㈜|주식회사",
    re.IGNORECASE,
)
PUBLIC_FACILITY_HINT_RE = re.compile(
    r"공원|시장|광장|역사|지하철역|철도역|터미널|해수욕장|해변|체육관|문화센터|복지관|"
    r"주민센터|행정복지센터|구청|시청|도청|군청|면사무소|읍사무소|동사무소|도서관|"
    r"박물관|미술관|주차장|하천|강변|관광|생태|숲|오름|포구|공영|공중화장실|개방화장실|휴게소|국립공원",
    re.IGNORECASE,
)

PO_CD_PARKS = {
    "101": "지리산국립공원",
    "201": "계룡산국립공원",
    "301": "한려해상국립공원",
    "401": "설악산국립공원",
    "501": "속리산국립공원",
    "601": "내장산국립공원",
    "701": "가야산국립공원",
    "801": "덕유산국립공원",
    "901": "오대산국립공원",
    "1001": "주왕산국립공원",
    "1101": "태안해안국립공원",
    "1201": "다도해해상국립공원",
    "1301": "치악산국립공원",
    "1401": "월악산국립공원",
    "1501": "북한산국립공원",
    "1601": "소백산국립공원",
    "1701": "월출산국립공원",
    "1801": "변산반도국립공원",
    "1901": "경주국립공원",
    "2001": "한라산국립공원",
}

REGIONAL_BBOX = {
    "서울": (37.35, 37.75, 126.70, 127.30),
    "부산": (34.85, 35.40, 128.75, 129.35),
    "대전": (36.15, 36.52, 127.22, 127.58),
    "울산": (35.30, 35.75, 128.95, 129.50),
    "제주": (33.05, 34.05, 126.05, 127.05),
    "충북": (36.00, 37.30, 127.20, 128.70),
    "경기": (36.85, 38.30, 126.35, 127.90),
    "전북": (35.15, 36.20, 126.30, 127.95),
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
        ("서울특별시", "서울특별시"), ("서울시", "서울특별시"), ("서울", "서울특별시"),
        ("부산광역시", "부산광역시"), ("부산시", "부산광역시"), ("부산", "부산광역시"),
        ("대구광역시", "대구광역시"), ("대구시", "대구광역시"), ("대구", "대구광역시"),
        ("인천광역시", "인천광역시"), ("인천시", "인천광역시"), ("인천", "인천광역시"),
        ("광주광역시", "광주광역시"), ("광주시", "광주광역시"),
        ("대전광역시", "대전광역시"), ("대전시", "대전광역시"), ("대전", "대전광역시"),
        ("울산광역시", "울산광역시"), ("울산시", "울산광역시"), ("울산", "울산광역시"),
        ("세종특별자치시", "세종특별자치시"), ("세종시", "세종특별자치시"), ("세종", "세종특별자치시"),
        ("경기도", "경기도"), ("경기", "경기도"),
        ("강원특별자치도", "강원특별자치도"), ("강원도", "강원특별자치도"), ("강원", "강원특별자치도"),
        ("충청북도", "충청북도"), ("충북", "충청북도"),
        ("충청남도", "충청남도"), ("충남", "충청남도"),
        ("전북특별자치도", "전북특별자치도"), ("전라북도", "전북특별자치도"), ("전북", "전북특별자치도"),
        ("전라남도", "전라남도"), ("전남", "전라남도"),
        ("경상북도", "경상북도"), ("경북", "경상북도"),
        ("경상남도", "경상남도"), ("경남", "경상남도"),
        ("제주특별자치도", "제주특별자치도"), ("제주도", "제주특별자치도"), ("제주", "제주특별자치도"),
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
    if ns != first or first in {
        "서울특별시", "부산광역시", "대구광역시", "인천광역시", "광주광역시",
        "대전광역시", "울산광역시", "세종특별자치시", "경기도", "강원특별자치도",
        "충청북도", "충청남도", "전북특별자치도", "전라남도", "경상북도", "경상남도", "제주특별자치도"
    }:
        return ns
    # check city prefixes
    if any(k in addr for k in ["제주시", "서귀포시"]):
        return "제주특별자치도"
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


def utm52n_to_wgs84(easting: float, northing: float) -> Tuple[float, float]:
    a = 6378137.0
    f = 1.0 / 298.257223563
    k0 = 0.9996
    e2 = f * (2.0 - f)
    ep2 = e2 / (1.0 - e2)
    x = easting - 500000.0
    y = northing
    m = y / k0
    mu = m / (a * (1.0 - e2 / 4.0 - 3.0 * e2 ** 2 / 64.0 - 5.0 * e2 ** 3 / 256.0))
    e1 = (1.0 - math.sqrt(1.0 - e2)) / (1.0 + math.sqrt(1.0 - e2))
    phi1 = (
        mu
        + (3.0 * e1 / 2.0 - 27.0 * e1 ** 3 / 32.0) * math.sin(2.0 * mu)
        + (21.0 * e1 ** 2 / 16.0 - 55.0 * e1 ** 4 / 32.0) * math.sin(4.0 * mu)
        + (151.0 * e1 ** 3 / 96.0) * math.sin(6.0 * mu)
    )
    c1 = ep2 * math.cos(phi1) ** 2
    t1 = math.tan(phi1) ** 2
    n1 = a / math.sqrt(1.0 - e2 * math.sin(phi1) ** 2)
    r1 = a * (1.0 - e2) / (1.0 - e2 * math.sin(phi1) ** 2) ** 1.5
    d = x / (n1 * k0)
    lat = phi1 - (n1 * math.tan(phi1) / r1) * (
        d ** 2 / 2.0
        - (5.0 + 3.0 * t1 + 10.0 * c1 - 4.0 * c1 ** 2 - 9.0 * ep2) * d ** 4 / 24.0
        + (61.0 + 90.0 * t1 + 298.0 * c1 + 45.0 * t1 ** 2 - 252.0 * ep2 - 3.0 * c1 ** 2) * d ** 6 / 720.0
    )
    lon = math.radians(129.0) + (
        d
        - (1.0 + 2.0 * t1 + c1) * d ** 3 / 6.0
        + (5.0 - 2.0 * c1 + 28.0 * t1 - 3.0 * c1 ** 2 + 8.0 * ep2 + 24.0 * t1 ** 2) * d ** 5 / 120.0
    ) / math.cos(phi1)
    return math.degrees(lat), math.degrees(lon)


def load_admin_regions() -> List[Dict[str, Any]]:
    raw = open(ADMIN_REGIONS_TS, encoding="utf-8").read()
    start = raw.find("export const KOREA_ADMIN_REGIONS")
    eq_idx = raw.find("= [", start)
    bracket_start = raw.find("[", eq_idx)
    bracket_end = raw.find("];", bracket_start)
    arr_str = raw[bracket_start : bracket_end + 1]
    arr_str = re.sub(r",(\s*[}\]])", r"\1", arr_str)
    return json.loads(arr_str)


def resolve_admin_region(lat: float, lng: float, regions: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    matches = [
        r
        for r in regions
        if r["south"] <= lat <= r["north"] and r["west"] <= lng <= r["east"]
    ]
    if not matches:
        # fallback: nearest bbox center
        best = min(
            regions,
            key=lambda r: ((r["south"] + r["north"]) / 2.0 - lat) ** 2
            + ((r["west"] + r["east"]) / 2.0 - lng) ** 2,
        )
        return best
    # Prefer tightest bbox area; also slightly un-buffer by checking distance to center
    return min(
        matches,
        key=lambda r: (
            (r["north"] - r["south"]) * (r["east"] - r["west"]),
            ((r["south"] + r["north"]) / 2.0 - lat) ** 2
            + ((r["west"] + r["east"]) / 2.0 - lng) ** 2,
        ),
    )


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


def is_restricted_or_private(name: str, ownership: str = "", ftype: str = "", open_hours: str = "") -> Optional[str]:
    text_all = f"{name} {ownership} {ftype}"
    if TEMP_OR_CLOSED_RE.search(text_all):
        return "temp_or_closed"
    if PRIVATE_OWNERSHIP_RE.search(ownership):
        if "개방" not in ftype or not open_hours.strip():
            return "open_private_unclear_access"
    if RESTRICTED_OR_PRIVATE_NAME_RE.search(name) and not PUBLIC_FACILITY_HINT_RE.search(name):
        return "restricted_or_private_name"
    return None


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
    "jeju_city": SourceSpec(
        uuid="eeeeeeee-eeee-4eee-8eee-000000000101",
        provider="제주특별자치도 제주시",
        dataset="제주특별자치도 제주시_공중화장실",
        source_url="https://www.data.go.kr/data/15110521/fileData.do",
        license_name="이용허락범위 제한 없음",
        license_url="https://www.data.go.kr/ugs/selectPortalPolicyView.do",
        attribution="출처: 제주특별자치도 제주시 / 공공데이터포털(15110521)",
        coordinate_source="jeju_public_toilet",
        base_date="2025-12-31",
    ),
    "jeju_bf": SourceSpec(
        uuid="eeeeeeee-eeee-4eee-8eee-000000000102",
        provider="제주특별자치도",
        dataset="제주특별자치도_무장애여행정보 공중·장애인화장실",
        source_url="https://www.data.go.kr/data/15075152/fileData.do",
        license_name="이용허락범위 제한 없음",
        license_url="https://www.data.go.kr/ugs/selectPortalPolicyView.do",
        attribution="출처: 제주특별자치도 / 공공데이터포털(무장애여행정보 15075152~15075200)",
        coordinate_source="jeju_public_toilet",
        base_date="2020-12-22",
    ),
    "jeju_poi": SourceSpec(
        uuid="eeeeeeee-eeee-4eee-8eee-000000000103",
        provider="제주특별자치도",
        dataset="제주특별자치도_제주도장소(POI)데이터 (2026 표준데이터 교차검증 공중화장실)",
        source_url="https://www.data.go.kr/data/15004770/fileData.do",
        license_name="이용허락범위 제한 없음",
        license_url="https://www.data.go.kr/ugs/selectPortalPolicyView.do",
        attribution="출처: 제주특별자치도 / 공공데이터포털(15004770)",
        coordinate_source="jeju_public_toilet",
        base_date="2015-12-31",
    ),
    "busan_galmaetgil": SourceSpec(
        uuid="eeeeeeee-eeee-4eee-8eee-000000000104",
        provider="부산광역시",
        dataset="부산광역시_갈맷길 화장실정보(SHP)",
        source_url="https://www.data.go.kr/data/15084238/fileData.do",
        license_name="이용허락범위 제한 없음",
        license_url="https://www.data.go.kr/ugs/selectPortalPolicyView.do",
        attribution="출처: 부산광역시 / 공공데이터포털(15084238)",
        coordinate_source="busan_district_public_toilet",
        base_date="2025-10-30",
    ),
    "daejeon_junggu": SourceSpec(
        uuid="eeeeeeee-eeee-4eee-8eee-000000000105",
        provider="대전광역시 중구",
        dataset="대전광역시 중구_안심화장실",
        source_url="https://www.data.go.kr/data/15126560/fileData.do",
        license_name="이용허락범위 제한 없음",
        license_url="https://www.data.go.kr/ugs/selectPortalPolicyView.do",
        attribution="출처: 대전광역시 중구 / 공공데이터포털(15126560)",
        coordinate_source="daejeon_public_toilet",
        base_date="2026-09-28",
    ),
    "ulsan_grandpark": SourceSpec(
        uuid="eeeeeeee-eeee-4eee-8eee-000000000106",
        provider="울산시설공단",
        dataset="울산시설공단_울산대공원 편의시설 통합 위치정보",
        source_url="https://www.data.go.kr/data/15167288/fileData.do",
        license_name="이용허락범위 제한 없음",
        license_url="https://www.data.go.kr/ugs/selectPortalPolicyView.do",
        attribution="출처: 울산시설공단 / 공공데이터포털(15167288)",
        coordinate_source="ulsan_public_toilet",
        base_date="2026-09-22",
    ),
    "chungbuk_jincheon": SourceSpec(
        uuid="eeeeeeee-eeee-4eee-8eee-000000000107",
        provider="충청북도 진천군",
        dataset="충청북도 진천군_공간정보 기반 생활편의시설 위치 및 분류 정보",
        source_url="https://www.data.go.kr/data/15151847/fileData.do",
        license_name="이용허락범위 제한 없음",
        license_url="https://www.data.go.kr/ugs/selectPortalPolicyView.do",
        attribution="출처: 충청북도 진천군 / 공공데이터포털(15151847)",
        coordinate_source="chungbuk_public_toilet",
        base_date="2026-11-05",
    ),
    "gyeonggi_ansan": SourceSpec(
        uuid="eeeeeeee-eeee-4eee-8eee-000000000108",
        provider="경기도 안산시",
        dataset="경기도 안산시_개방화장실 현황",
        source_url="https://www.data.go.kr/data/15123020/fileData.do",
        license_name="이용허락범위 제한 없음",
        license_url="https://www.data.go.kr/ugs/selectPortalPolicyView.do",
        attribution="출처: 경기도 안산시 / 공공데이터포털(15123020)",
        coordinate_source="gyeonggi_city_public_toilet",
        base_date="2026-01-13",
    ),
    "seoul_olympic": SourceSpec(
        uuid="eeeeeeee-eeee-4eee-8eee-000000000109",
        provider="서울올림픽기념국민체육진흥공단",
        dataset="서울올림픽기념국민체육진흥공단_올림픽공원 편의시설 정보",
        source_url="https://www.data.go.kr/data/15089799/fileData.do",
        license_name="이용허락범위 제한 없음",
        license_url="https://www.data.go.kr/ugs/selectPortalPolicyView.do",
        attribution="출처: 서울올림픽기념국민체육진흥공단 / 공공데이터포털(15089799)",
        coordinate_source="seoul_park_public_toilet",
        base_date="2026-01-01",
    ),
    "knps_parks": SourceSpec(
        uuid="eeeeeeee-eeee-4eee-8eee-000000000110",
        provider="국립공원공단",
        dataset="국립공원공단_국립공원 화장실 공간데이터",
        source_url="https://www.data.go.kr/data/15003468/fileData.do",
        license_name="이용허락범위 제한 없음",
        license_url="https://www.data.go.kr/ugs/selectPortalPolicyView.do",
        attribution="출처: 국립공원공단 / 공공데이터포털(15003468·2257840·15136179)",
        coordinate_source="knps_national_park_toilet",
        base_date="2025-08-01",
    ),
    "mois_bike": SourceSpec(
        uuid="eeeeeeee-eeee-4eee-8eee-000000000111",
        provider="행정안전부",
        dataset="행정안전부_자전거길 DB (국토종주자전거길 화장실)",
        source_url="https://www.data.go.kr/data/3038533/fileData.do",
        license_name="이용허락범위 제한 없음",
        license_url="https://www.data.go.kr/ugs/selectPortalPolicyView.do",
        attribution="출처: 행정안전부 / 공공데이터포털(3038533)",
        coordinate_source="mois_bike_trail_toilet",
        base_date="2025-06-18",
    ),
    "mof_beach": SourceSpec(
        uuid="eeeeeeee-eeee-4eee-8eee-000000000112",
        provider="해양수산부",
        dataset="해양수산부_공동활용체계_공유해해수욕장정보 (2026 표준데이터 교차검증 화장실)",
        source_url="https://www.data.go.kr/data/15147562/fileData.do",
        license_name="이용허락범위 제한 없음",
        license_url="https://www.data.go.kr/ugs/selectPortalPolicyView.do",
        attribution="출처: 해양수산부·국립해양조사원 / 공공데이터포털(15147562)",
        coordinate_source="mof_beach_toilet",
        base_date="2025-08-28",
    ),
    "kex_restarea": SourceSpec(
        uuid="eeeeeeee-eeee-4eee-8eee-000000000113",
        provider="한국도로공사",
        dataset="한국도로공사_고속도로 휴게소 위치·화장실 현황",
        source_url="https://data.ex.co.kr/portal/fdwn/view?type=ETC&num=Y3",
        license_name="공공데이터법 제1·3조 및 저작권법 제24조의2 자유이용 (이용허락범위 제한 없음)",
        license_url="https://data.ex.co.kr/portal/guide/publicDataPolicy",
        attribution="출처: 한국도로공사 고속도로 공공데이터 포털(Y3·locationinfoRest) / 공공데이터포털(15043712)",
        coordinate_source="kex_highway_rest_area_toilet",
        base_date="2026-01-02",
    ),
    "jeonbuk_2026": SourceSpec(
        uuid="eeeeeeee-eeee-4eee-8eee-000000000114",
        provider="전북특별자치도",
        dataset="전북특별자치도_남자·여성화장실현황 (추가 공중화장실)",
        source_url="https://www.data.go.kr/data/15175342/fileData.do",
        license_name="이용허락범위 제한 없음",
        license_url="https://www.data.go.kr/ugs/selectPortalPolicyView.do",
        attribution="출처: 전북특별자치도 / 공공데이터포털(15175342·15175446)",
        coordinate_source="jeonbuk_public_toilet",
        base_date="2026-10-22",
    ),
}


def load_sb_json(path: str) -> List[Dict[str, Any]]:
    raw = open(path, "rb").read()
    txt = raw.decode("utf-16") if raw[:2] in (b"\xff\xfe", b"\xfe\xff") else raw.decode("utf-8-sig")
    return json.loads(txt[txt.find("{"):]).get("rows", [])


def sql_str(v: Optional[str]) -> str:
    if v is None:
        return "NULL"
    return "'" + v.replace("'", "''") + "'"


def sql_bool(v: Optional[bool]) -> str:
    if v is None:
        return "NULL"
    return "true" if v else "false"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--restrooms-json", required=True)
    parser.add_argument("--candidates-json", required=True)
    parser.add_argument("--write-sql", action="store_true")
    args = parser.parse_args()

    regions = load_admin_regions()
    existing_restrooms = load_sb_json(args.restrooms_json)
    candidates = load_sb_json(args.candidates_json)

    # Spatial + name/addr indexes of existing remote restrooms
    spatial_grid: Dict[Tuple[int, int], List[Tuple[float, float]]] = {}
    existing_name_addr: set[Tuple[str, str]] = set()
    for r in existing_restrooms:
        lat, lng = r.get("latitude"), r.get("longitude")
        if lat is not None and lng is not None:
            spatial_grid.setdefault((int(float(lat) * 1000), int(float(lng) * 1000)), []).append(
                (float(lat), float(lng))
            )
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

    # Index candidates for 2026 corroboration & official_matched updates (O(1) lookups)
    all_cands_by_sido: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    unloc_by_sido_name: Dict[Tuple[str, str], str] = {}
    unloc_by_sido_addr: Dict[Tuple[str, str], str] = {}
    unloc_by_sido_sigungu: Dict[Tuple[str, str], List[Tuple[str, str]]] = defaultdict(list)
    for c in candidates:
        sido = norm_sido(c.get("sido_name"))
        all_cands_by_sido[sido].append(c)
        if c.get("coordinate_status") == "unlocated":
            cid = c["id"]
            cn = c.get("normalized_name") or norm_text(c.get("name"))
            if cn and (sido, cn) not in unloc_by_sido_name:
                unloc_by_sido_name[(sido, cn)] = cid
            for a_field in ("road_address", "jibun_address"):
                ca = norm_addr_core(c.get(a_field))
                if ca and len(ca) >= 8 and (sido, ca) not in unloc_by_sido_addr:
                    unloc_by_sido_addr[(sido, ca)] = cid
            sg = (c.get("sigungu_name") or "").strip()
            if cn and sg:
                unloc_by_sido_sigungu[(sido, sg)].append((cn, cid))

    # Wave 1 held Jeonbuk names (any name in 15134318) so we NEVER re-release Wave 1 held items
    w1_jb_rows = read_csv_bytes(open(os.path.join(W1_DATA_DIR, "15134318.csv"), "rb").read())
    w1_jb_names = {norm_text(r[4]) for r in w1_jb_rows[1:] if len(r) > 4 and r[4].strip()}

    # Load bike trail polyline lookup for accurate trail naming in 3038533
    bike_route_pts: List[Tuple[float, float, str]] = []
    with zipfile.ZipFile(os.path.join(W2_DATA_DIR, "3038533.zip")) as z:
        for nm in z.namelist():
            if "노선좌표" in nm and nm.endswith(".csv"):
                b_rows = read_csv_bytes(z.read(nm))
                for idx_r, r in enumerate(b_rows[1:]):
                    if idx_r % 5 != 0 or len(r) < 4:
                        continue
                    try:
                        # note header is 순서,국토종주 자전거길,위도(LINE_XP),경도(LINE_YP)
                        # verify lat vs lng order safely
                        v2, v3 = float(r[2]), float(r[3])
                        lat, lng = (v2, v3) if 33 <= v2 <= 39 else (v3, v2)
                        bike_route_pts.append((lat, lng, r[1].strip()))
                    except Exception:
                        pass

    def resolve_bike_route(lat: float, lng: float, csv_route: str) -> str:
        if not bike_route_pts:
            return csv_route
        best_d = 1e9
        best_rt = csv_route
        for plat, plng, prt in bike_route_pts:
            if abs(plat - lat) > 0.08 or abs(plng - lng) > 0.08:
                continue
            d = (plat - lat) ** 2 + (plng - lng) ** 2
            if d < best_d:
                best_d = d
                best_rt = prt
        if best_d < (0.03 ** 2):
            return best_rt
        return csv_route

    accepted: List[Dict[str, Any]] = []
    seen_restroom_ids: set[str] = set()
    seen_source_rec_keys: set[Tuple[str, str]] = set()
    stats: Dict[str, Dict[str, int]] = defaultdict(lambda: defaultdict(int))
    matched_candidate_ids: Dict[str, str] = {}

    def process_candidate_rows(source_key: str, raw_items: List[Dict[str, Any]], region_bbox_key: Optional[str] = None) -> None:
        spec = SOURCE_SPECS[source_key]
        # 5-decimal coordinate grouping
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
            hold = is_restricted_or_private(
                item["name"], item.get("ownership", ""), item.get("ftype", ""), item.get("open_hours", "")
            )
            if hold:
                stats[source_key][f"hold_{hold}"] += 1
                continue
            key5 = (round(lat, 5), round(lng, 5))
            coord_groups[key5].append(item)
            pre_filtered.append(item)

        # Collapse floor duplicates (>=2 on identical 5-decimal coord) or hold complex copies
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
                # Keep representative first item; annotate if multiple floors
                if len(grp) <= 5:
                    rep = dict(grp[0])
                    if len(grp) > 1:
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
            na = norm_addr_core(item["road_address"] or item.get("address_detail"))
            nn = norm_text(item["name"])
            if not item.get("skip_name_addr_dedup") and nn and na and (nn, na) in existing_name_addr:
                stats[source_key]["dedup_name_addr"] += 1
                continue

            rec_id = item["record_id"]
            if (spec.uuid, rec_id) in seen_source_rec_keys:
                rec_id = f"{rec_id}-DUP-{stats[source_key]['accepted'] + 1}"
            restroom_id = deterministic_uuid(f"wave2:{spec.uuid}:{rec_id}")
            while restroom_id in seen_restroom_ids:
                rec_id = f"{rec_id}-U"
                restroom_id = deterministic_uuid(f"wave2:{spec.uuid}:{rec_id}")
            seen_source_rec_keys.add((spec.uuid, rec_id))
            seen_restroom_ids.add(restroom_id)
            reg = resolve_admin_region(lat, lng, regions)
            road_clean = (item.get("road_address") or "").strip()
            if not road_clean:
                road_clean = (
                    f"{reg['sidoName']} {reg['sigunguName']}"
                    if reg
                    else spec.provider
                )
            sido = extract_sido_from_address(road_clean or item.get("address_detail"))
            if not sido:
                sido = reg["sidoName"] if reg else ""
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
                "last_verified_at": f"{spec.base_date}T00:00:00.000Z",
                "sido": sido,
            }
            accepted.append(row)
            mark_occupied(lat, lng, item["name"], item["road_address"])
            stats[source_key]["accepted"] += 1

            # Match against unlocated candidates (O(1) dict + tight sigungu scan)
            if item.get("corroborated_candidate_id"):
                cid = item["corroborated_candidate_id"]
                if cid not in matched_candidate_ids:
                    matched_candidate_ids[cid] = restroom_id
            elif sido:
                r_core = norm_text(re.sub(r"(공중화장실|개방화장실|화장실)$", "", name_clean))
                r_addr = norm_addr_core(road_clean)
                matched_cid = unloc_by_sido_name.get((sido, nn))
                if not matched_cid and r_addr and len(r_addr) >= 8:
                    matched_cid = unloc_by_sido_addr.get((sido, r_addr))
                if not matched_cid and len(r_core) >= 3:
                    for (csido, sg), pairs in unloc_by_sido_sigungu.items():
                        if csido == sido and sg in road_clean:
                            for cn, cid in pairs:
                                if r_core in cn and cid not in matched_candidate_ids:
                                    matched_cid = cid
                                    break
                        if matched_cid:
                            break
                if matched_cid and matched_cid not in matched_candidate_ids:
                    matched_candidate_ids[matched_cid] = restroom_id

    # 1. 15110521 Jeju-si
    rows = read_csv_bytes(open(os.path.join(W2_DATA_DIR, "15110521.csv"), "rb").read())
    items = []
    for idx_r, r in enumerate(rows[1:], 1):
        if len(r) < 27:
            continue
        try:
            lat, lng = float(r[5]), float(r[6])
        except Exception:
            items.append({"pre_hold": "missing_coord", "lat": 0, "lng": 0, "name": r[2]})
            continue
        road = r[3].strip() or r[4].strip()
        jibun = r[4].strip()
        unisex = parse_bool_yn(r[16])
        gender = "unisex" if unisex is True else ("separate" if unisex is False else "unknown")
        wc = (int(r[19] or 0) + int(r[20] or 0) + int(r[24] or 0)) > 0 if (r[19] or r[20] or r[24]) else None
        bc = parse_bool_yn(r[15])
        desc_parts = []
        if r[7].strip(): desc_parts.append(f"개방시간: {r[7].strip()}")
        if r[8].strip(): desc_parts.append(f"관리: {r[8].strip()}")
        if r[9].strip(): desc_parts.append(f"전화: {r[9].strip()}")
        desc_parts.append(f"{SOURCE_SPECS['jeju_city'].attribution} / 기준일: {r[26].strip() or '2025-12-31'}")
        items.append({
            "record_id": r[0].strip() or f"JEJU-{idx_r}",
            "name": r[2].strip(),
            "road_address": road,
            "address_detail": f"(지번) {jibun}" if jibun and jibun != road else None,
            "lat": lat, "lng": lng,
            "ownership": r[10].strip(), "ftype": r[1].strip(), "open_hours": r[7].strip(),
            "gender_type": gender, "wheelchair_accessible": wc, "baby_changing_available": bc,
            "description": " / ".join(desc_parts),
        })
    process_candidate_rows("jeju_city", items, "제주")

    # 2. Jeju Barrier-Free (15075152..15075200)
    bf_dir = os.path.join(W2_DATA_DIR, "jeju_barrier_free")
    items = []
    for fn in sorted(os.listdir(bf_dir)):
        if not fn.endswith(".csv"):
            continue
        pid = fn.replace(".csv", "")
        rows = read_csv_bytes(open(os.path.join(bf_dir, fn), "rb").read())
        for idx_r, r in enumerate(rows[1:], 1):
            if len(r) < 8:
                continue
            nm = r[2].strip()
            if "화장실" not in nm or any(skip in nm for skip in ("경사로", "단차", "출입", "입구", "점자", "손잡이", "세면대", "문폭", "턱", "안내판")):
                continue
            if r[6].strip() and r[6].strip() != "정상":
                continue
            try:
                lat, lng = float(r[0]), float(r[1])
            except Exception:
                continue
            reg = resolve_admin_region(lat, lng, regions)
            region_label = f"{reg['sidoName']} {reg['sigunguName']}" if reg else "제주특별자치도"
            wc = True if "장애인화장실" in r[4] else None
            items.append({
                "record_id": f"{pid}-{idx_r}",
                "name": nm,
                "road_address": region_label,
                "address_detail": f"(무장애관광지 안내) {r[3].strip()}" if r[3].strip() else None,
                "lat": lat, "lng": lng,
                "wheelchair_accessible": wc,
                "description": f"무장애정보: {r[4].strip()} / 출처: 제주특별자치도 / 공공데이터포털({pid}) / 기준일: {r[7].strip() or '2020-12-22'}",
            })
    process_candidate_rows("jeju_bf", items, "제주")

    # 3. 15004770 Jeju POI (2015) — ONLY 2026 candidate-corroborated rows!
    rows = read_csv_bytes(open(os.path.join(W2_DATA_DIR, "15004770.csv"), "rb").read())
    jeju_cands = all_cands_by_sido.get("제주특별자치도", [])
    items = []
    for idx_r, r in enumerate(rows[1:], 1):
        if len(r) < 7 or ("화장실" not in r[4] and "화장실" not in r[3]):
            continue
        try:
            lng, lat = float(r[1]), float(r[2])
        except Exception:
            continue
        nm, addr = r[4].strip(), r[5].strip()
        core = re.sub(r"(공중화장실|개방화장실|개방용화장실|화장실)$", "", norm_text(nm))
        lot = re.search(r"([가-힣]+(?:동|읍|면|리))\s*(산?\s*\d+(?:-\d+)?)", addr)
        corr = None
        for c in jeju_cands:
            ca = (c.get("jibun_address") or "") + " " + (c.get("road_address") or "")
            if lot and lot.group(1) in ca and lot.group(2).replace(" ", "") in ca:
                corr = c
                break
            if len(core) >= 2 and core in (c.get("normalized_name") or "") and (
                ("서귀포" in addr and "서귀포" in (c.get("sigungu_name") or ""))
                or ("제주시" in addr and "제주" in (c.get("sigungu_name") or ""))
            ):
                corr = c
                break
        if not corr:
            items.append({"pre_hold": "uncorroborated_2015_poi", "lat": lat, "lng": lng, "name": nm})
            continue
        road = corr.get("road_address") or addr
        items.append({
            "record_id": r[0].strip() or f"JPOI-{idx_r}",
            "name": corr.get("name") or nm,
            "road_address": road,
            "address_detail": f"(지번) {addr}" if addr != road else None,
            "lat": lat, "lng": lng,
            "corroborated_candidate_id": corr["id"] if corr.get("coordinate_status") == "unlocated" else None,
            "description": f"2026 표준데이터 교차검증 확인 / {SOURCE_SPECS['jeju_poi'].attribution} / 기준일: {r[6].strip() or '2015-12-31'}",
        })
    process_candidate_rows("jeju_poi", items, "제주")

    # 4. 15084238 Busan Galmaetgil SHP
    items = []
    with zipfile.ZipFile(os.path.join(W2_DATA_DIR, "15084238.zip")) as z:
        dbf = z.read("gmgRestroomInfo.dbf")
        num_rec, hdr_len, rec_len = struct.unpack("<IHH", dbf[4:12])
        pos, flds = 32, []
        while dbf[pos] != 0x0D:
            flds.append((dbf[pos : pos + 11].split(b"\x00")[0].decode("utf-8", "replace"), dbf[pos + 16]))
            pos += 32
        for i in range(num_rec):
            rec = dbf[hdr_len + i * rec_len : hdr_len + (i + 1) * rec_len]
            if rec[0] == 0x2A:
                continue
            cur, row = 1, {}
            for fnm, fl in flds:
                row[fnm] = rec[cur : cur + fl].decode("utf-8", "replace").strip()
                cur += fl
            try:
                lat, lng = float(row["위도"]), float(row["lon"])
            except Exception:
                continue
            road = next((v for k, v in row.items() if k.startswith("도로명") and v), "")
            jibun = next((v for k, v in row.items() if k.startswith("지번") and v), "")
            mgr = next((v for k, v in row.items() if k.startswith("관리기") and v), "")
            hours = next((v for k, v in row.items() if k.startswith("이용가") and v), "")
            unisex_v = next((v for k, v in row.items() if k.startswith("남녀공") and v), "")
            unisex = parse_bool_yn(unisex_v)
            items.append({
                "record_id": f"GMG-{i+1}",
                "name": row.get("이름", "갈맷길 화장실"),
                "road_address": road or jibun or "부산광역시 갈맷길 일원",
                "address_detail": f"(지번) {jibun}" if jibun and jibun != road else None,
                "lat": lat, "lng": lng,
                "ftype": row.get("구분", ""),
                "open_hours": hours,
                "gender_type": "unisex" if unisex is True else ("separate" if unisex is False else "unknown"),
                "description": f"개방시간: {hours or '미상'} / 관리: {mgr or '부산광역시'} / {SOURCE_SPECS['busan_galmaetgil'].attribution} / 기준일: 2025-10-30",
            })
    process_candidate_rows("busan_galmaetgil", items, "부산")

    # 5. 15126560 Daejeon Jung-gu
    rows = read_csv_bytes(open(os.path.join(W2_DATA_DIR, "15126560.csv"), "rb").read())
    items = []
    for idx_r, r in enumerate(rows[1:], 1):
        if len(r) < 12:
            continue
        try:
            lng, lat = float(r[3]), float(r[4])
        except Exception:
            continue
        raw_addr = r[2].strip()
        full_addr = raw_addr if raw_addr.startswith("대전") else f"대전광역시 중구 {raw_addr}"
        items.append({
            "record_id": r[0].strip() or f"DJJG-{idx_r}",
            "name": r[1].strip(),
            "road_address": full_addr,
            "address_detail": f"(위치/구분) {r[5].strip()} {r[12].strip()}".strip() if len(r) > 12 else None,
            "lat": lat, "lng": lng,
            "ftype": "공중화장실",
            "open_hours": r[11].strip(),
            "description": f"개방시간: {r[11].strip() or '상시개방'} / 관리: 대전광역시 중구 {r[8].strip()} / {SOURCE_SPECS['daejeon_junggu'].attribution}",
        })
    process_candidate_rows("daejeon_junggu", items, "대전")

    # 6. 15167288 Ulsan Grand Park
    rows = read_csv_bytes(open(os.path.join(W2_DATA_DIR, "15167288.csv"), "rb").read())
    items = []
    for idx_r, r in enumerate(rows[1:], 1):
        if len(r) < 10 or "화장실" not in r[2]:
            continue
        try:
            lat, lng = float(r[4]), float(r[5])
        except Exception:
            continue
        items.append({
            "record_id": r[0].strip() or f"ULGP-{idx_r}",
            "name": f"울산대공원 {r[3].strip()} {r[2].strip()}".strip(),
            "road_address": "울산광역시 남구 대공원로 94",
            "address_detail": f"(공원 내 위치) {r[3].strip()}",
            "lat": lat, "lng": lng,
            "wheelchair_accessible": parse_bool_yn(r[7]),
            "open_hours": r[6].strip(),
            "description": f"개방시간: {r[6].strip()} / 관리: 울산시설공단 / {SOURCE_SPECS['ulsan_grandpark'].attribution} / 기준일: {r[9].strip()}",
        })
    process_candidate_rows("ulsan_grandpark", items, "울산")

    # 7. 15151847 Chungbuk Jincheon
    rows = read_csv_bytes(open(os.path.join(W2_DATA_DIR, "15151847.csv"), "rb").read())
    items = []
    for idx_r, r in enumerate(rows[1:], 1):
        if len(r) < 7 or "화장실" not in r[0]:
            continue
        try:
            lat, lng = float(r[5]), float(r[6])
        except Exception:
            continue
        addr = re.sub(r"\s+", " ", r[3].strip()).replace("충북 ", "충청북도 ")
        items.append({
            "record_id": f"CBJC-{idx_r}",
            "name": r[0].strip(),
            "road_address": addr,
            "address_detail": f"(행정구역) 충청북도 진천군 {r[4].strip()}",
            "lat": lat, "lng": lng,
            "description": f"관리: 충청북도 진천군 / {SOURCE_SPECS['chungbuk_jincheon'].attribution}",
        })
    process_candidate_rows("chungbuk_jincheon", items, "충북")

    # 8. 15123020 Gyeonggi Ansan
    rows = read_csv_bytes(open(os.path.join(W2_DATA_DIR, "15123020.csv"), "rb").read())
    items = []
    for idx_r, r in enumerate(rows[1:], 1):
        if len(r) < 8:
            continue
        try:
            lat, lng = float(r[4]), float(r[5])
        except Exception:
            continue
        road = r[1].strip()
        if not road.startswith("경기"):
            road = f"경기도 {road}"
        wc = True if "장애인 칸 있음" in r[6] else (False if "장애인 칸 없음" in r[6] else None)
        items.append({
            "record_id": f"ANSAN-{idx_r}",
            "name": r[0].strip(),
            "road_address": road,
            "address_detail": f"(행정동) {r[3].strip()}",
            "lat": lat, "lng": lng,
            "ftype": "개방화장실",
            "open_hours": r[6].strip(),
            "wheelchair_accessible": wc,
            "description": f"{r[6].strip()} / 관리: 경기도 안산시 / {SOURCE_SPECS['gyeonggi_ansan'].attribution} / 기준일: {r[7].strip()}",
        })
    process_candidate_rows("gyeonggi_ansan", items, "경기")

    # 9. 15089799 Seoul Olympic Park
    rows = read_csv_bytes(open(os.path.join(W2_DATA_DIR, "15089799.csv"), "rb").read())
    items = []
    for idx_r, r in enumerate(rows[1:], 1):
        if len(r) < 6 or "화장실" not in r[1]:
            continue
        if "게이트 내부" in r[3] or "게이트내부" in r[3].replace(" ", ""):
            items.append({"pre_hold": "ticketed_arena_interior", "lat": 0, "lng": 0, "name": r[2]})
            continue
        try:
            lat, lng = float(r[4]), float(r[5])
        except Exception:
            continue
        items.append({
            "record_id": f"OLPK-{r[0].strip() or idx_r}",
            "name": f"올림픽공원 {r[2].strip()} {r[3].strip()} 화장실".replace("  ", " ").strip(),
            "road_address": "서울특별시 송파구 올림픽로 424",
            "address_detail": f"(공원 내 위치) {r[2].strip()} {r[3].strip()}".strip(),
            "lat": lat, "lng": lng,
            "description": f"관리: 서울올림픽기념국민체육진흥공단 / {SOURCE_SPECS['seoul_olympic'].attribution}",
        })
    process_candidate_rows("seoul_olympic", items, "서울")

    # 10. National Parks (15003468 PT + 2257840 PG_UTM52N + 15136179 기타구축물)
    items = []
    with zipfile.ZipFile(os.path.join(W2_DATA_DIR, "15003468.zip")) as z:
        csv_name = [n for n in z.namelist() if n.endswith(".csv")][0]
        rows = read_csv_bytes(z.read(csv_name))
        for idx_r, r in enumerate(rows[1:], 1):
            if len(r) < 14:
                continue
            if r[10].strip() != "1":
                items.append({"pre_hold": "not_in_use", "lat": 0, "lng": 0, "name": r[5]})
                continue
            try:
                lng, lat = float(r[12]), float(r[13])
            except Exception:
                continue
            po_cd = r[2].strip()
            park_nm = PO_CD_PARKS.get(po_cd, "국립공원")
            reg = resolve_admin_region(lat, lng, regions)
            reg_str = f"{reg['sidoName']} {reg['sigunguName']}" if reg else ""
            raw_road = r[8].strip()
            raw_jibun = r[7].strip()
            road = raw_road if (raw_road and "미변환" not in raw_road) else (raw_jibun if (raw_jibun and "미변환" not in raw_jibun) else f"{reg_str} {park_nm}".strip())
            wc = True if r[9].strip() == "1" else (False if r[9].strip() == "0" else None)
            items.append({
                "record_id": f"PT-{r[0].strip()}-{r[1].strip()}" if r[0].strip() else f"KNPS-PT-{idx_r}",
                "name": r[5].strip(),
                "road_address": road,
                "address_detail": f"(국립공원) {park_nm}" + (f" / (지번) {raw_jibun}" if raw_jibun and "미변환" not in raw_jibun and raw_jibun != road else ""),
                "lat": lat, "lng": lng,
                "wheelchair_accessible": wc,
                "description": f"공원: {park_nm} / 관리: 국립공원공단 / {SOURCE_SPECS['knps_parks'].attribution}",
            })
    with zipfile.ZipFile(os.path.join(W2_DATA_DIR, "2257840.zip")) as z:
        dbf = z.read("GSTN_TOILET_PG_UTM52N.dbf")
        shp = z.read("GSTN_TOILET_PG_UTM52N.shp")
        num_rec, hdr_len, rec_len = struct.unpack("<IHH", dbf[4:12])
        pos, flds = 32, []
        while dbf[pos] != 0x0D:
            flds.append((dbf[pos : pos + 11].split(b"\x00")[0].decode("ascii", "replace"), dbf[pos + 16]))
            pos += 32
        off, idx = 100, 0
        while off < len(shp) and idx < num_rec:
            _, content_len = struct.unpack(">II", shp[off : off + 8])
            content = shp[off + 8 : off + 8 + content_len * 2]
            off += 8 + content_len * 2
            dbf_rec = dbf[hdr_len + idx * rec_len : hdr_len + (idx + 1) * rec_len]
            idx += 1
            if dbf_rec[0] == 0x2A:
                continue
            cur, row = 1, {}
            for fnm, fl in flds:
                row[fnm] = dbf_rec[cur : cur + fl].decode("cp949", "replace").strip()
                cur += fl
            if row.get("USE_YN") != "1":
                continue
            xmin, ymin, xmax, ymax = struct.unpack("<4d", content[4:36])
            lat, lng = utm52n_to_wgs84((xmin + xmax) / 2.0, (ymin + ymax) / 2.0)
            park_nm = PO_CD_PARKS.get(row.get("PO_CD", "").strip(), "국립공원")
            reg = resolve_admin_region(lat, lng, regions)
            reg_str = f"{reg['sidoName']} {reg['sigunguName']}" if reg else ""
            raw_road = row.get("RDNMADR", "").strip()
            raw_jibun = row.get("LNM_ADRES", "").strip()
            road = raw_road if (raw_road and "미변환" not in raw_road) else (raw_jibun if (raw_jibun and "미변환" not in raw_jibun) else f"{reg_str} {park_nm}".strip())
            items.append({
                "record_id": f"PG-{row.get('ID_CD') or idx}",
                "name": row.get("KOR_NM", "").strip() or f"{park_nm} 화장실",
                "road_address": road,
                "address_detail": f"(국립공원 공간객체 중심) {park_nm}",
                "lat": lat, "lng": lng,
                "wheelchair_accessible": True if row.get("DSPSN_TOIL") == "1" else None,
                "description": f"공원: {park_nm} / 관리: 국립공원공단 / {SOURCE_SPECS['knps_parks'].attribution}",
            })
    # Also 15136179 (간이화장실 point)
    rows_ext = read_csv_bytes(open(os.path.join(W2_DATA_DIR, "15136179.csv"), "rb").read())
    for idx_r, r in enumerate(rows_ext[1:], 1):
        if len(r) >= 10 and "화장실" in r[0] and r[8].strip() and r[9].strip():
            try:
                lng, lat = float(r[8]), float(r[9])
            except Exception:
                continue
            reg = resolve_admin_region(lat, lng, regions)
            reg_str = f"{reg['sidoName']} {reg['sigunguName']}" if reg else "국립공원"
            items.append({
                "record_id": f"EXT-{idx_r}",
                "name": r[0].strip(),
                "road_address": f"{reg_str} 국립공원",
                "address_detail": f"(상대위치) {r[1].strip()}" if r[1].strip() else None,
                "lat": lat, "lng": lng,
                "description": f"관리: 국립공원공단 / {SOURCE_SPECS['knps_parks'].attribution}",
            })
    process_candidate_rows("knps_parks", items)

    # 11. 3038533 National Bike Trails
    items = []
    with zipfile.ZipFile(os.path.join(W2_DATA_DIR, "3038533.zip")) as z:
        for nm in z.namelist():
            if "주변시설" in nm and nm.endswith(".csv"):
                rows = read_csv_bytes(z.read(nm))
                for idx_r, r in enumerate(rows[1:], 1):
                    if len(r) < 4 or "화장실" not in r[0]:
                        continue
                    try:
                        lng, lat = float(r[2]), float(r[3])
                    except Exception:
                        continue
                    true_route = resolve_bike_route(lat, lng, r[1].strip())
                    reg = resolve_admin_region(lat, lng, regions)
                    reg_str = f"{reg['sidoName']} {reg['sigunguName']}" if reg else ""
                    items.append({
                        "record_id": f"BIKE-{idx_r}",
                        "name": f"{true_route} 자전거길 공중화장실",
                        "road_address": f"{reg_str} 국토종주자전거길 ({true_route})".strip(),
                        "address_detail": f"(자전거길 노선) {true_route}",
                        "lat": lat, "lng": lng,
                        "skip_name_addr_dedup": True,
                        "description": f"국토종주자전거길 {true_route} 주변 공중화장실 / 관리: 행정안전부 / {SOURCE_SPECS['mois_bike'].attribution}",
                    })
    process_candidate_rows("mois_bike", items)

    # 12. 15147562 MOF Beaches (2014) — ONLY 2026 candidate-corroborated rows!
    rows = read_csv_bytes(open(os.path.join(W2_DATA_DIR, "15147562.csv"), "rb").read())
    items = []
    for idx_r, r in enumerate(rows[1:], 1):
        if len(r) < 10 or "화장실" not in r[4]:
            continue
        try:
            lng, lat = float(r[6]), float(r[7])
        except Exception:
            continue
        bname = re.sub(r"(해수욕장|해변)$", "", norm_text(r[3]))
        addr = r[5].strip()
        tokens = [t for t in addr.split() if len(t) >= 2]
        corr = None
        if len(bname) >= 2:
            for c in candidates:
                cn = c.get("normalized_name") or norm_text(c.get("name"))
                ca = (c.get("sido_name") or "") + " " + (c.get("sigungu_name") or "") + " " + (c.get("jibun_address") or "")
                if bname in cn and any(t[:2] in ca for t in tokens[:2]):
                    corr = c
                    break
        if not corr:
            items.append({"pre_hold": "uncorroborated_2014_beach", "lat": lat, "lng": lng, "name": r[3]})
            continue
        reg = resolve_admin_region(lat, lng, regions)
        full_addr = corr.get("road_address") or corr.get("jibun_address") or (f"{reg['sidoName']} {addr}" if reg and not extract_sido_from_address(addr) else addr)
        items.append({
            "record_id": r[0].strip() or f"BEACH-{idx_r}",
            "name": f"{r[3].strip()} 화장실",
            "road_address": full_addr,
            "address_detail": f"(시설물) {r[4].strip()} / 2026 표준데이터 교차검증 확인",
            "lat": lat, "lng": lng,
            "corroborated_candidate_id": corr["id"] if corr.get("coordinate_status") == "unlocated" else None,
            "description": f"2026 표준데이터 교차검증 확인 / 시설: {r[4].strip()} / {SOURCE_SPECS['mof_beach'].attribution}",
        })
    process_candidate_rows("mof_beach", items)

    # 13. Korea Expressway Rest Areas (cross-verified with Y3 2025 & 15043712)
    locs = json.load(open(os.path.join(W2_DATA_DIR, "kex_locationinfoRest.json"), encoding="utf-8"))
    svar = json.load(open(os.path.join(W2_DATA_DIR, "kex_hiwaySvarInfoList.json"), encoding="utf-8"))
    y3_rows = read_csv_bytes(open(os.path.join(W2_DATA_DIR, "kex_y3_2025.csv"), "rb").read())
    f12_rows = read_csv_bytes(open(os.path.join(W2_DATA_DIR, "15043712.csv"), "rb").read())

    svar_by_nm = {x["svarNm"]: x for x in svar if x.get("svarNm")}
    y3_rest_map = {r[3].strip(): r for r in y3_rows[1:] if len(r) > 16 and r[2].strip() == "휴게소"}
    f12_map = {r[1].strip(): r for r in f12_rows[1:] if len(r) >= 4}

    items = []
    for idx_r, x in enumerate(locs, 1):
        nm = (x.get("unitName") or "").strip()
        try:
            lng, lat = float(x["xValue"]), float(x["yValue"])
        except Exception:
            continue
        sv = svar_by_nm.get(nm)
        if not sv:
            for k, v in svar_by_nm.items():
                if nm and (nm in k or k in nm):
                    sv = v
                    break
        raw_addr = (sv.get("svarAddr", "") if sv else "").strip()
        sido = extract_sido_from_address(raw_addr)
        if not sido:
            reg = resolve_admin_region(lat, lng, regions)
            sido = reg["sidoName"] if reg else ""
            raw_addr = f"{reg['sidoName']} {raw_addr}".strip() if reg and raw_addr else (f"{reg['sidoName']} {reg['sigunguName']} {x.get('routeName','')}".strip() if reg else nm)
        else:
            # normalize short sido prefix like 충남 -> 충청남도
            first = raw_addr.split()[0]
            if sido and first != sido:
                raw_addr = raw_addr.replace(first, sido, 1)

        y3 = y3_rest_map.get(nm)
        wc = True if (y3 and (int(y3[15] or 0) + int(y3[16] or 0)) > 0) else None
        f12 = f12_map.get(nm.replace("휴게소", ""))
        cnt_txt = f"남자변기 {f12[2]}칸·여자변기 {f12[3]}칸 / " if f12 else ""
        items.append({
            "record_id": x.get("stdRestCd") or f"KEX-{idx_r}",
            "name": f"{nm} 화장실",
            "road_address": raw_addr,
            "address_detail": f"(고속도로 노선) {x.get('routeName', '')}".strip(),
            "lat": lat, "lng": lng,
            "open_hours": "상시 (24시간)",
            "gender_type": "separate",
            "wheelchair_accessible": wc,
            "description": f"{cnt_txt}개방시간: 24시간 / 노선: {x.get('routeName', '')} / 관리: 한국도로공사 / {SOURCE_SPECS['kex_restarea'].attribution}",
        })
    process_candidate_rows("kex_restarea", items)

    # 14. 15175342 & 15175446 Jeonbuk 2026-10-22 additional public toilets ONLY
    jb_m = read_csv_bytes(open(os.path.join(W2_DATA_DIR, "15175342.csv"), "rb").read())
    jb_f = read_csv_bytes(open(os.path.join(W2_DATA_DIR, "15175446.csv"), "rb").read())
    jb_f_coords = {(round(float(r[5]), 4), round(float(r[4]), 4)) for r in jb_f[1:] if len(r) >= 6 and r[4] and r[5]}
    items = []
    for idx_r, r in enumerate(jb_m[1:], 1):
        if len(r) < 6 or r[0].strip() != "공중화장실":
            continue
        nm = r[1].strip()
        if norm_text(nm) in w1_jb_names:
            # Never re-evaluate records already audited in Wave 1 15134318
            items.append({"pre_hold": "covered_by_wave1_15134318", "lat": 0, "lng": 0, "name": nm})
            continue
        try:
            lng, lat = float(r[4]), float(r[5])
        except Exception:
            continue
        addr = r[2].strip()
        if not addr.startswith("전북") and not addr.startswith("전라"):
            addr = f"전북특별자치도 {addr}"
        has_f = (round(lat, 4), round(lng, 4)) in jb_f_coords
        items.append({
            "record_id": f"JB2026-{idx_r}",
            "name": nm if "화장실" in nm else f"{nm} 공중화장실",
            "road_address": addr,
            "address_detail": f"(지번) {addr}",
            "lat": lat, "lng": lng,
            "ftype": "공중화장실",
            "gender_type": "separate" if has_f else "unknown",
            "description": f"관리: {r[3].strip() or '전북특별자치도'} / {SOURCE_SPECS['jeonbuk_2026'].attribution} / 기준일: 2026-10-22",
        })
    process_candidate_rows("jeonbuk_2026", items, "전북")

    # Summary by sido
    by_sido = Counter(r["sido"] for r in accepted)
    by_src = Counter(r["coordinate_source"] for r in accepted)
    summary = {
        "totalNewRestrooms": len(accepted),
        "candidateMatchesToMarkOfficial": len(matched_candidate_ids),
        "bySido": dict(sorted(by_sido.items(), key=lambda x: -x[1])),
        "byCoordinateSource": dict(sorted(by_src.items(), key=lambda x: -x[1])),
        "perDatasetStats": {k: dict(v) for k, v in stats.items()},
    }

    if args.write_sql:
        os.makedirs(SQL_OUT_DIR, exist_ok=True)
        for old in os.listdir(SQL_OUT_DIR):
            if old.endswith(".sql"):
                os.remove(os.path.join(SQL_OUT_DIR, old))

        # 00_sources.sql
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
        with open(os.path.join(SQL_OUT_DIR, "00_wave2_sources.sql"), "w", encoding="utf-8") as f:
            f.write("\n".join(src_lines) + "\n")

        # 01_wave2_official_NNN.sql (250 rows per batch)
        batch_size = 250
        for b_idx in range(0, len(accepted), batch_size):
            chunk = accepted[b_idx : b_idx + batch_size]
            lines = ["BEGIN;", "INSERT INTO public.restrooms (",
                     "  id, type, business_id, source_id, source_record_id,",
                     "  coordinate_source, coordinate_source_id, coordinate_source_record_id,",
                     "  coordinate_type, coordinate_verification_status, coordinate_verification_basis, coordinate_source_version,",
                     "  name, description, road_address, address_detail, latitude, longitude,",
                     "  floor, entrance_instructions, gender_type, wheelchair_accessible, baby_changing_available,",
                     "  access_method, publication_status, last_verified_at",
                     ") VALUES"]
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
            out_file = os.path.join(SQL_OUT_DIR, f"01_wave2_official_{b_idx // batch_size:03d}.sql")
            with open(out_file, "w", encoding="utf-8") as f:
                f.write("\n".join(lines) + "\n")

        # 02_wave2_candidate_updates.sql
        cand_pairs = list(matched_candidate_ids.items())
        if cand_pairs:
            lines = ["BEGIN;", "UPDATE public.public_restroom_candidates AS c",
                     "SET coordinate_status = 'official_matched',",
                     "    matched_restroom_id = v.restroom_id,",
                     "    updated_at = now()",
                     "FROM (VALUES"]
            lines.append(",\n".join(f"  ('{cid}'::uuid, '{rid}'::uuid)" for cid, rid in cand_pairs))
            lines.append(") AS v(candidate_id, restroom_id)")
            lines.append("WHERE c.id = v.candidate_id")
            lines.append("  AND c.coordinate_status = 'unlocated'")
            lines.append("  AND EXISTS (SELECT 1 FROM public.restrooms r WHERE r.id = v.restroom_id);")
            lines.append("COMMIT;")
            with open(os.path.join(SQL_OUT_DIR, "02_wave2_candidate_updates.sql"), "w", encoding="utf-8") as f:
                f.write("\n".join(lines) + "\n")

        with open(SUMMARY_OUT, "w", encoding="utf-8") as f:
            json.dump(summary, f, ensure_ascii=False, indent=2)

    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
