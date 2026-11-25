/**
 * 대한민국 행정구역(시·도, 시·군·구) 경계 박스 및 개방자치단체코드 매핑
 *
 * - 통계청(KOSTAT) 시군구 경계 기반 최소 외접 사각형(±0.015° 인접 경계 버퍼 포함)
 * - 카카오 좌표 및 행안부 주소 DB 좌표를 전혀 사용하지 않는다.
 * - 지도 bounds와 교차하는 시군구(인접 경계 포함)만 인덱스로 조회한다.
 */
import type { MapBounds } from "@/lib/maps/types";

export interface KoreaAdminRegion {
  readonly sidoCode: string;
  readonly sigunguCode: string;
  readonly sidoName: string;
  readonly sigunguName: string;
  readonly south: number;
  readonly west: number;
  readonly north: number;
  readonly east: number;
}

export interface OrgRegionInfo {
  readonly sidoCode: string;
  readonly sigunguCode: string;
  readonly sidoName: string;
  readonly sigunguName: string;
}

export const MAX_CANDIDATE_VIEWPORT_LAT_SPAN = 0.12;
export const MAX_CANDIDATE_VIEWPORT_LNG_SPAN = 0.16;

export const KOREA_ADMIN_REGIONS: readonly KoreaAdminRegion[] = [
  {
    "sidoCode": "11",
    "sigunguCode": "11010",
    "sidoName": "서울특별시",
    "sigunguName": "종로구",
    "south": 37.55082,
    "west": 126.9339,
    "north": 37.64737,
    "east": 127.03836
  },
  {
    "sidoCode": "11",
    "sigunguCode": "11020",
    "sidoName": "서울특별시",
    "sigunguName": "중구",
    "south": 37.52886,
    "west": 126.94657,
    "north": 37.58696,
    "east": 127.04177
  },
  {
    "sidoCode": "11",
    "sigunguCode": "11030",
    "sidoName": "서울특별시",
    "sigunguName": "용산구",
    "south": 37.49152,
    "west": 126.92959,
    "north": 37.57066,
    "east": 127.03253
  },
  {
    "sidoCode": "11",
    "sigunguCode": "11040",
    "sidoName": "서울특별시",
    "sigunguName": "성동구",
    "south": 37.51333,
    "west": 126.99315,
    "north": 37.58799,
    "east": 127.08874
  },
  {
    "sidoCode": "11",
    "sigunguCode": "11050",
    "sidoName": "서울특별시",
    "sigunguName": "광진구",
    "south": 37.50751,
    "west": 127.04122,
    "north": 37.58876,
    "east": 127.13023
  },
  {
    "sidoCode": "11",
    "sigunguCode": "11060",
    "sidoName": "서울특별시",
    "sigunguName": "동대문구",
    "south": 37.54496,
    "west": 127.00814,
    "north": 37.62402,
    "east": 127.0932
  },
  {
    "sidoCode": "11",
    "sigunguCode": "11070",
    "sidoName": "서울특별시",
    "sigunguName": "중랑구",
    "south": 37.5547,
    "west": 127.05442,
    "north": 37.63569,
    "east": 127.1331
  },
  {
    "sidoCode": "11",
    "sigunguCode": "11080",
    "sidoName": "서울특별시",
    "sigunguName": "성북구",
    "south": 37.56252,
    "west": 126.95968,
    "north": 37.65144,
    "east": 127.08671
  },
  {
    "sidoCode": "11",
    "sigunguCode": "11090",
    "sidoName": "서울특별시",
    "sigunguName": "강북구",
    "south": 37.59407,
    "west": 126.96466,
    "north": 37.70007,
    "east": 127.06474
  },
  {
    "sidoCode": "11",
    "sigunguCode": "11100",
    "sidoName": "서울특별시",
    "sigunguName": "도봉구",
    "south": 37.61551,
    "west": 126.99329,
    "north": 37.71646,
    "east": 127.07088
  },
  {
    "sidoCode": "11",
    "sigunguCode": "11110",
    "sidoName": "서울특별시",
    "sigunguName": "노원구",
    "south": 37.59927,
    "west": 127.02666,
    "north": 37.71114,
    "east": 127.12748
  },
  {
    "sidoCode": "11",
    "sigunguCode": "11120",
    "sidoName": "서울특별시",
    "sigunguName": "은평구",
    "south": 37.56101,
    "west": 126.86706,
    "north": 37.67419,
    "east": 126.97833
  },
  {
    "sidoCode": "11",
    "sigunguCode": "11130",
    "sidoName": "서울특별시",
    "sigunguName": "서대문구",
    "south": 37.5401,
    "west": 126.88689,
    "north": 37.62562,
    "east": 126.98446
  },
  {
    "sidoCode": "11",
    "sigunguCode": "11140",
    "sidoName": "서울특별시",
    "sigunguName": "마포구",
    "south": 37.51879,
    "west": 126.83863,
    "north": 37.60579,
    "east": 126.97849
  },
  {
    "sidoCode": "11",
    "sigunguCode": "11150",
    "sidoName": "서울특별시",
    "sigunguName": "양천구",
    "south": 37.48782,
    "west": 126.8068,
    "north": 37.56624,
    "east": 126.90551
  },
  {
    "sidoCode": "11",
    "sigunguCode": "11160",
    "sidoName": "서울특별시",
    "sigunguName": "강서구",
    "south": 37.51149,
    "west": 126.74948,
    "north": 37.62003,
    "east": 126.89566
  },
  {
    "sidoCode": "11",
    "sigunguCode": "11170",
    "sidoName": "서울특별시",
    "sigunguName": "구로구",
    "south": 37.45824,
    "west": 126.79801,
    "north": 37.53293,
    "east": 126.9182
  },
  {
    "sidoCode": "11",
    "sigunguCode": "11180",
    "sidoName": "서울특별시",
    "sigunguName": "금천구",
    "south": 37.4186,
    "west": 126.85676,
    "north": 37.50132,
    "east": 126.94351
  },
  {
    "sidoCode": "11",
    "sigunguCode": "11190",
    "sidoName": "서울특별시",
    "sigunguName": "영등포구",
    "south": 37.47,
    "west": 126.86303,
    "north": 37.57127,
    "east": 126.96489
  },
  {
    "sidoCode": "11",
    "sigunguCode": "11200",
    "sidoName": "서울특별시",
    "sigunguName": "동작구",
    "south": 37.46038,
    "west": 126.8882,
    "north": 37.53261,
    "east": 127.00039
  },
  {
    "sidoCode": "11",
    "sigunguCode": "11210",
    "sidoName": "서울특별시",
    "sigunguName": "관악구",
    "south": 37.42071,
    "west": 126.88394,
    "north": 37.51008,
    "east": 127.00364
  },
  {
    "sidoCode": "11",
    "sigunguCode": "11220",
    "sidoName": "서울특별시",
    "sigunguName": "서초구",
    "south": 37.41381,
    "west": 126.9654,
    "north": 37.5406,
    "east": 127.11072
  },
  {
    "sidoCode": "11",
    "sigunguCode": "11230",
    "sidoName": "서울특별시",
    "sigunguName": "강남구",
    "south": 37.44137,
    "west": 126.99358,
    "north": 37.55083,
    "east": 127.13921
  },
  {
    "sidoCode": "11",
    "sigunguCode": "11240",
    "sidoName": "서울특별시",
    "sigunguName": "송파구",
    "south": 37.45152,
    "west": 127.05248,
    "north": 37.55817,
    "east": 127.17643
  },
  {
    "sidoCode": "11",
    "sigunguCode": "11250",
    "sidoName": "서울특별시",
    "sigunguName": "강동구",
    "south": 37.50183,
    "west": 127.09424,
    "north": 37.5962,
    "east": 127.19854
  },
  {
    "sidoCode": "26",
    "sigunguCode": "21010",
    "sidoName": "부산광역시",
    "sigunguName": "중구",
    "south": 35.08069,
    "west": 129.00619,
    "north": 35.13143,
    "east": 129.06182
  },
  {
    "sidoCode": "26",
    "sigunguCode": "21020",
    "sidoName": "부산광역시",
    "sigunguName": "서구",
    "south": 35.03237,
    "west": 128.98103,
    "north": 35.15599,
    "east": 129.0431
  },
  {
    "sidoCode": "26",
    "sigunguCode": "21030",
    "sidoName": "부산광역시",
    "sigunguName": "동구",
    "south": 35.09261,
    "west": 129.0093,
    "north": 35.16118,
    "east": 129.08112
  },
  {
    "sidoCode": "26",
    "sigunguCode": "21040",
    "sidoName": "부산광역시",
    "sigunguName": "영도구",
    "south": 35.03427,
    "west": 129.01612,
    "north": 35.11901,
    "east": 129.12025
  },
  {
    "sidoCode": "26",
    "sigunguCode": "21050",
    "sidoName": "부산광역시",
    "sigunguName": "부산진구",
    "south": 35.12066,
    "west": 128.99557,
    "north": 35.21508,
    "east": 129.09784
  },
  {
    "sidoCode": "26",
    "sigunguCode": "21060",
    "sidoName": "부산광역시",
    "sigunguName": "동래구",
    "south": 35.16865,
    "west": 129.02913,
    "north": 35.24119,
    "east": 129.13104
  },
  {
    "sidoCode": "26",
    "sigunguCode": "21070",
    "sidoName": "부산광역시",
    "sigunguName": "남구",
    "south": 35.06941,
    "west": 129.04801,
    "north": 35.17631,
    "east": 129.14398
  },
  {
    "sidoCode": "26",
    "sigunguCode": "21080",
    "sidoName": "부산광역시",
    "sigunguName": "북구",
    "south": 35.17247,
    "west": 128.97274,
    "north": 35.29189,
    "east": 129.07677
  },
  {
    "sidoCode": "26",
    "sigunguCode": "21090",
    "sidoName": "부산광역시",
    "sigunguName": "해운대구",
    "south": 35.13637,
    "west": 129.09524,
    "north": 35.26594,
    "east": 129.22342
  },
  {
    "sidoCode": "26",
    "sigunguCode": "21100",
    "sidoName": "부산광역시",
    "sigunguName": "사하구",
    "south": 34.96325,
    "west": 128.90922,
    "north": 35.15183,
    "east": 129.02937
  },
  {
    "sidoCode": "26",
    "sigunguCode": "21110",
    "sidoName": "부산광역시",
    "sigunguName": "금정구",
    "south": 35.1951,
    "west": 129.02156,
    "north": 35.32153,
    "east": 129.1596
  },
  {
    "sidoCode": "26",
    "sigunguCode": "21120",
    "sidoName": "부산광역시",
    "sigunguName": "강서구",
    "south": 34.97362,
    "west": 128.75038,
    "north": 35.25108,
    "east": 129.01322
  },
  {
    "sidoCode": "26",
    "sigunguCode": "21130",
    "sidoName": "부산광역시",
    "sigunguName": "연제구",
    "south": 35.14317,
    "west": 129.03233,
    "north": 35.21446,
    "east": 129.13019
  },
  {
    "sidoCode": "26",
    "sigunguCode": "21140",
    "sidoName": "부산광역시",
    "sigunguName": "수영구",
    "south": 35.12076,
    "west": 129.07658,
    "north": 35.20126,
    "east": 129.15033
  },
  {
    "sidoCode": "26",
    "sigunguCode": "21150",
    "sidoName": "부산광역시",
    "sigunguName": "사상구",
    "south": 35.1019,
    "west": 128.94245,
    "north": 35.21646,
    "east": 129.03607
  },
  {
    "sidoCode": "26",
    "sigunguCode": "21310",
    "sidoName": "부산광역시",
    "sigunguName": "기장군",
    "south": 35.16698,
    "west": 129.09356,
    "north": 35.40404,
    "east": 129.32075
  },
  {
    "sidoCode": "27",
    "sigunguCode": "22010",
    "sidoName": "대구광역시",
    "sigunguName": "중구",
    "south": 35.83991,
    "west": 128.55877,
    "north": 35.89458,
    "east": 128.62966
  },
  {
    "sidoCode": "27",
    "sigunguCode": "22020",
    "sidoName": "대구광역시",
    "sigunguName": "동구",
    "south": 35.83616,
    "west": 128.58838,
    "north": 36.03117,
    "east": 128.77633
  },
  {
    "sidoCode": "27",
    "sigunguCode": "22030",
    "sidoName": "대구광역시",
    "sigunguName": "서구",
    "south": 35.8393,
    "west": 128.50135,
    "north": 35.91222,
    "east": 128.59684
  },
  {
    "sidoCode": "27",
    "sigunguCode": "22040",
    "sidoName": "대구광역시",
    "sigunguName": "남구",
    "south": 35.79219,
    "west": 128.5405,
    "north": 35.87507,
    "east": 128.62384
  },
  {
    "sidoCode": "27",
    "sigunguCode": "22050",
    "sidoName": "대구광역시",
    "sigunguName": "북구",
    "south": 35.85878,
    "west": 128.48983,
    "north": 36.00282,
    "east": 128.6476
  },
  {
    "sidoCode": "27",
    "sigunguCode": "22060",
    "sidoName": "대구광역시",
    "sigunguName": "수성구",
    "south": 35.77513,
    "west": 128.57649,
    "north": 35.89333,
    "east": 128.74197
  },
  {
    "sidoCode": "27",
    "sigunguCode": "22070",
    "sidoName": "대구광역시",
    "sigunguName": "달서구",
    "south": 35.75794,
    "west": 128.45369,
    "north": 35.88457,
    "east": 128.6028
  },
  {
    "sidoCode": "27",
    "sigunguCode": "22310",
    "sidoName": "대구광역시",
    "sigunguName": "달성군",
    "south": 35.59154,
    "west": 128.33648,
    "north": 35.95815,
    "east": 128.71049
  },
  {
    "sidoCode": "28",
    "sigunguCode": "23010",
    "sidoName": "인천광역시",
    "sigunguName": "중구",
    "south": 37.34174,
    "west": 126.34027,
    "north": 37.5586,
    "east": 126.6584
  },
  {
    "sidoCode": "28",
    "sigunguCode": "23020",
    "sidoName": "인천광역시",
    "sigunguName": "동구",
    "south": 37.4533,
    "west": 126.59484,
    "north": 37.5109,
    "east": 126.68943
  },
  {
    "sidoCode": "28",
    "sigunguCode": "23030",
    "sidoName": "인천광역시",
    "sigunguName": "남구",
    "south": 37.41495,
    "west": 126.61387,
    "north": 37.49903,
    "east": 126.71794
  },
  {
    "sidoCode": "28",
    "sigunguCode": "23040",
    "sidoName": "인천광역시",
    "sigunguName": "연수구",
    "south": 37.3223,
    "west": 126.56564,
    "north": 37.45438,
    "east": 126.72165
  },
  {
    "sidoCode": "28",
    "sigunguCode": "23050",
    "sidoName": "인천광역시",
    "sigunguName": "남동구",
    "south": 37.36611,
    "west": 126.65185,
    "north": 37.49493,
    "east": 126.79543
  },
  {
    "sidoCode": "28",
    "sigunguCode": "23060",
    "sidoName": "인천광역시",
    "sigunguName": "부평구",
    "south": 37.44973,
    "west": 126.66825,
    "north": 37.53908,
    "east": 126.78275
  },
  {
    "sidoCode": "28",
    "sigunguCode": "23070",
    "sidoName": "인천광역시",
    "sigunguName": "계양구",
    "south": 37.50856,
    "west": 126.66606,
    "north": 37.6087,
    "east": 126.8087
  },
  {
    "sidoCode": "28",
    "sigunguCode": "23080",
    "sidoName": "인천광역시",
    "sigunguName": "서구",
    "south": 37.45659,
    "west": 126.54013,
    "north": 37.65321,
    "east": 126.74046
  },
  {
    "sidoCode": "28",
    "sigunguCode": "23310",
    "sidoName": "인천광역시",
    "sigunguName": "강화군",
    "south": 37.56487,
    "west": 125.9566,
    "north": 37.84656,
    "east": 126.55896
  },
  {
    "sidoCode": "28",
    "sigunguCode": "23320",
    "sidoName": "인천광역시",
    "sigunguName": "옹진군",
    "south": 36.91185,
    "west": 124.59472,
    "north": 37.99924,
    "east": 126.56669
  },
  {
    "sidoCode": "29",
    "sigunguCode": "24010",
    "sidoName": "광주광역시",
    "sigunguName": "동구",
    "south": 35.05766,
    "west": 126.89216,
    "north": 35.18049,
    "east": 127.01928
  },
  {
    "sidoCode": "29",
    "sigunguCode": "24020",
    "sidoName": "광주광역시",
    "sigunguName": "서구",
    "south": 35.07593,
    "west": 126.78563,
    "north": 35.19348,
    "east": 126.92473
  },
  {
    "sidoCode": "29",
    "sigunguCode": "24030",
    "sidoName": "광주광역시",
    "sigunguName": "남구",
    "south": 35.03602,
    "west": 126.73814,
    "north": 35.16734,
    "east": 126.94459
  },
  {
    "sidoCode": "29",
    "sigunguCode": "24040",
    "sidoName": "광주광역시",
    "sigunguName": "북구",
    "south": 35.10611,
    "west": 126.81986,
    "north": 35.27346,
    "east": 127.03728
  },
  {
    "sidoCode": "29",
    "sigunguCode": "24050",
    "sidoName": "광주광역시",
    "sigunguName": "광산구",
    "south": 35.05518,
    "west": 126.62998,
    "north": 35.2737,
    "east": 126.8754
  },
  {
    "sidoCode": "30",
    "sigunguCode": "25010",
    "sidoName": "대전광역시",
    "sigunguName": "동구",
    "south": 36.17975,
    "west": 127.39866,
    "north": 36.45483,
    "east": 127.57468
  },
  {
    "sidoCode": "30",
    "sigunguCode": "25020",
    "sidoName": "대전광역시",
    "sigunguName": "중구",
    "south": 36.19243,
    "west": 127.35248,
    "north": 36.36463,
    "east": 127.47319
  },
  {
    "sidoCode": "30",
    "sigunguCode": "25030",
    "sidoName": "대전광역시",
    "sigunguName": "서구",
    "south": 36.1681,
    "west": 127.26442,
    "north": 36.38702,
    "east": 127.41961
  },
  {
    "sidoCode": "30",
    "sigunguCode": "25040",
    "sidoName": "대전광역시",
    "sigunguName": "유성구",
    "south": 36.24924,
    "west": 127.23165,
    "north": 36.51523,
    "east": 127.43527
  },
  {
    "sidoCode": "30",
    "sigunguCode": "25050",
    "sidoName": "대전광역시",
    "sigunguName": "대덕구",
    "south": 36.32593,
    "west": 127.3743,
    "north": 36.49218,
    "east": 127.51947
  },
  {
    "sidoCode": "31",
    "sigunguCode": "26010",
    "sidoName": "울산광역시",
    "sigunguName": "중구",
    "south": 35.5299,
    "west": 129.23758,
    "north": 35.61411,
    "east": 129.36868
  },
  {
    "sidoCode": "31",
    "sigunguCode": "26020",
    "sidoName": "울산광역시",
    "sigunguName": "남구",
    "south": 35.43924,
    "west": 129.22154,
    "north": 35.57191,
    "east": 129.40611
  },
  {
    "sidoCode": "31",
    "sigunguCode": "26030",
    "sidoName": "울산광역시",
    "sigunguName": "동구",
    "south": 35.45146,
    "west": 129.37263,
    "north": 35.5866,
    "east": 129.47364
  },
  {
    "sidoCode": "31",
    "sigunguCode": "26040",
    "sidoName": "울산광역시",
    "sigunguName": "북구",
    "south": 35.50104,
    "west": 129.27532,
    "north": 35.69444,
    "east": 129.47966
  },
  {
    "sidoCode": "31",
    "sigunguCode": "26310",
    "sidoName": "울산광역시",
    "sigunguName": "울주군",
    "south": 35.31305,
    "west": 128.95619,
    "north": 35.73992,
    "east": 129.39619
  },
  {
    "sidoCode": "36",
    "sigunguCode": "29010",
    "sidoName": "세종특별자치시",
    "sigunguName": "세종시",
    "south": 36.39176,
    "west": 127.11273,
    "north": 36.74882,
    "east": 127.4258
  },
  {
    "sidoCode": "41",
    "sigunguCode": "31011",
    "sidoName": "경기도",
    "sigunguName": "수원시장안구",
    "south": 37.27051,
    "west": 126.94581,
    "north": 37.36604,
    "east": 127.0547
  },
  {
    "sidoCode": "41",
    "sigunguCode": "31012",
    "sidoName": "경기도",
    "sigunguName": "수원시권선구",
    "south": 37.20954,
    "west": 126.91198,
    "north": 37.31834,
    "east": 127.05717
  },
  {
    "sidoCode": "41",
    "sigunguCode": "31013",
    "sidoName": "경기도",
    "sigunguName": "수원시팔달구",
    "south": 37.24152,
    "west": 126.96234,
    "north": 37.30861,
    "east": 127.06064
  },
  {
    "sidoCode": "41",
    "sigunguCode": "31014",
    "sidoName": "경기도",
    "sigunguName": "수원시영통구",
    "south": 37.21628,
    "west": 127.01739,
    "north": 37.336,
    "east": 127.10463
  },
  {
    "sidoCode": "41",
    "sigunguCode": "31021",
    "sidoName": "경기도",
    "sigunguName": "성남시수정구",
    "south": 37.38206,
    "west": 127.02677,
    "north": 37.48963,
    "east": 127.19193
  },
  {
    "sidoCode": "41",
    "sigunguCode": "31022",
    "sidoName": "경기도",
    "sigunguName": "성남시중원구",
    "south": 37.39022,
    "west": 127.10198,
    "north": 37.48981,
    "east": 127.21082
  },
  {
    "sidoCode": "41",
    "sigunguCode": "31023",
    "sidoName": "경기도",
    "sigunguName": "성남시분당구",
    "south": 37.31837,
    "west": 127.01273,
    "north": 37.43205,
    "east": 127.19225
  },
  {
    "sidoCode": "41",
    "sigunguCode": "31030",
    "sidoName": "경기도",
    "sigunguName": "의정부시",
    "south": 37.67081,
    "west": 126.98669,
    "north": 37.79534,
    "east": 127.16226
  },
  {
    "sidoCode": "41",
    "sigunguCode": "31041",
    "sidoName": "경기도",
    "sigunguName": "안양시만안구",
    "south": 37.34377,
    "west": 126.85524,
    "north": 37.46521,
    "east": 126.96403
  },
  {
    "sidoCode": "41",
    "sigunguCode": "31042",
    "sidoName": "경기도",
    "sigunguName": "안양시동안구",
    "south": 37.34649,
    "west": 126.9103,
    "north": 37.45579,
    "east": 126.99785
  },
  {
    "sidoCode": "41",
    "sigunguCode": "31050",
    "sidoName": "경기도",
    "sigunguName": "부천시",
    "south": 37.44338,
    "west": 126.72663,
    "north": 37.56924,
    "east": 126.8486
  },
  {
    "sidoCode": "41",
    "sigunguCode": "31060",
    "sidoName": "경기도",
    "sigunguName": "광명시",
    "south": 37.38652,
    "west": 126.8111,
    "north": 37.50982,
    "east": 126.91469
  },
  {
    "sidoCode": "41",
    "sigunguCode": "31070",
    "sidoName": "경기도",
    "sigunguName": "평택시",
    "south": 36.8866,
    "west": 126.76385,
    "north": 37.1596,
    "east": 127.1691
  },
  {
    "sidoCode": "41",
    "sigunguCode": "31080",
    "sidoName": "경기도",
    "sigunguName": "동두천시",
    "south": 37.84537,
    "west": 126.99122,
    "north": 37.99572,
    "east": 127.17002
  },
  {
    "sidoCode": "41",
    "sigunguCode": "31091",
    "sidoName": "경기도",
    "sigunguName": "안산시상록구",
    "south": 37.25248,
    "west": 126.80133,
    "north": 37.39244,
    "east": 126.95461
  },
  {
    "sidoCode": "41",
    "sigunguCode": "31092",
    "sidoName": "경기도",
    "sigunguName": "안산시단원구",
    "south": 37.07299,
    "west": 126.36399,
    "north": 37.38091,
    "east": 126.85814
  },
  {
    "sidoCode": "41",
    "sigunguCode": "31101",
    "sidoName": "경기도",
    "sigunguName": "고양시덕양구",
    "south": 37.55679,
    "west": 126.74452,
    "north": 37.76349,
    "east": 127.00913
  },
  {
    "sidoCode": "41",
    "sigunguCode": "31103",
    "sidoName": "경기도",
    "sigunguName": "고양시일산동구",
    "south": 37.61062,
    "west": 126.71747,
    "north": 37.75161,
    "east": 126.87107
  },
  {
    "sidoCode": "41",
    "sigunguCode": "31104",
    "sidoName": "경기도",
    "sigunguName": "고양시일산서구",
    "south": 37.63252,
    "west": 126.65536,
    "north": 37.72217,
    "east": 126.79683
  },
  {
    "sidoCode": "41",
    "sigunguCode": "31110",
    "sidoName": "경기도",
    "sigunguName": "과천시",
    "south": 37.38569,
    "west": 126.94591,
    "north": 37.48272,
    "east": 127.06237
  },
  {
    "sidoCode": "41",
    "sigunguCode": "31120",
    "sidoName": "경기도",
    "sigunguName": "구리시",
    "south": 37.54134,
    "west": 127.08589,
    "north": 37.66108,
    "east": 127.1856
  },
  {
    "sidoCode": "41",
    "sigunguCode": "31130",
    "sidoName": "경기도",
    "sigunguName": "남양주시",
    "south": 37.4905,
    "west": 127.06523,
    "north": 37.79553,
    "east": 127.39599
  },
  {
    "sidoCode": "41",
    "sigunguCode": "31140",
    "sidoName": "경기도",
    "sigunguName": "오산시",
    "south": 37.11032,
    "west": 126.97991,
    "north": 37.21555,
    "east": 127.11804
  },
  {
    "sidoCode": "41",
    "sigunguCode": "31150",
    "sidoName": "경기도",
    "sigunguName": "시흥시",
    "south": 37.29327,
    "west": 126.5994,
    "north": 37.48739,
    "east": 126.89664
  },
  {
    "sidoCode": "41",
    "sigunguCode": "31160",
    "sidoName": "경기도",
    "sigunguName": "군포시",
    "south": 37.29005,
    "west": 126.85789,
    "north": 37.39366,
    "east": 126.97706
  },
  {
    "sidoCode": "41",
    "sigunguCode": "31170",
    "sidoName": "경기도",
    "sigunguName": "의왕시",
    "south": 37.28532,
    "west": 126.91431,
    "north": 37.43054,
    "east": 127.06211
  },
  {
    "sidoCode": "41",
    "sigunguCode": "31180",
    "sidoName": "경기도",
    "sigunguName": "하남시",
    "south": 37.45377,
    "west": 127.12497,
    "north": 37.60677,
    "east": 127.3007
  },
  {
    "sidoCode": "41",
    "sigunguCode": "31191",
    "sidoName": "경기도",
    "sigunguName": "용인시처인구",
    "south": 37.06865,
    "west": 127.09417,
    "north": 37.3751,
    "east": 127.44275
  },
  {
    "sidoCode": "41",
    "sigunguCode": "31192",
    "sidoName": "경기도",
    "sigunguName": "용인시기흥구",
    "south": 37.20053,
    "west": 127.04972,
    "north": 37.33971,
    "east": 127.19213
  },
  {
    "sidoCode": "41",
    "sigunguCode": "31193",
    "sidoName": "경기도",
    "sigunguName": "용인시수지구",
    "south": 37.27828,
    "west": 127.00149,
    "north": 37.38713,
    "east": 127.15744
  },
  {
    "sidoCode": "41",
    "sigunguCode": "31200",
    "sidoName": "경기도",
    "sigunguName": "파주시",
    "south": 37.67361,
    "west": 126.64432,
    "north": 38.02559,
    "east": 127.03211
  },
  {
    "sidoCode": "41",
    "sigunguCode": "31210",
    "sidoName": "경기도",
    "sigunguName": "이천시",
    "south": 37.02625,
    "west": 127.31503,
    "north": 37.3767,
    "east": 127.65278
  },
  {
    "sidoCode": "41",
    "sigunguCode": "31220",
    "sidoName": "경기도",
    "sigunguName": "안성시",
    "south": 36.87878,
    "west": 127.08702,
    "north": 37.17073,
    "east": 127.53159
  },
  {
    "sidoCode": "41",
    "sigunguCode": "31230",
    "sidoName": "경기도",
    "sigunguName": "김포시",
    "south": 37.56471,
    "west": 126.50205,
    "north": 37.8051,
    "east": 126.81758
  },
  {
    "sidoCode": "41",
    "sigunguCode": "31240",
    "sidoName": "경기도",
    "sigunguName": "화성시",
    "south": 36.99838,
    "west": 126.52054,
    "north": 37.30877,
    "east": 127.17593
  },
  {
    "sidoCode": "41",
    "sigunguCode": "31250",
    "sidoName": "경기도",
    "sigunguName": "광주시",
    "south": 37.25002,
    "west": 127.1176,
    "north": 37.55086,
    "east": 127.46086
  },
  {
    "sidoCode": "41",
    "sigunguCode": "31260",
    "sidoName": "경기도",
    "sigunguName": "양주시",
    "south": 37.65369,
    "west": 126.88695,
    "north": 37.95712,
    "east": 127.13719
  },
  {
    "sidoCode": "41",
    "sigunguCode": "31270",
    "sidoName": "경기도",
    "sigunguName": "포천시",
    "south": 37.73193,
    "west": 127.0748,
    "north": 38.20323,
    "east": 127.46208
  },
  {
    "sidoCode": "41",
    "sigunguCode": "31280",
    "sidoName": "경기도",
    "sigunguName": "여주시",
    "south": 37.12006,
    "west": 127.38322,
    "north": 37.45543,
    "east": 127.78341
  },
  {
    "sidoCode": "41",
    "sigunguCode": "31350",
    "sidoName": "경기도",
    "sigunguName": "연천군",
    "south": 37.91323,
    "west": 126.77134,
    "north": 38.29726,
    "east": 127.20716
  },
  {
    "sidoCode": "41",
    "sigunguCode": "31370",
    "sidoName": "경기도",
    "sigunguName": "가평군",
    "south": 37.55615,
    "west": 127.25191,
    "north": 38.06621,
    "east": 127.63214
  },
  {
    "sidoCode": "41",
    "sigunguCode": "31380",
    "sidoName": "경기도",
    "sigunguName": "양평군",
    "south": 37.35201,
    "west": 127.29092,
    "north": 37.68579,
    "east": 127.86311
  },
  {
    "sidoCode": "51",
    "sigunguCode": "32010",
    "sidoName": "강원특별자치도",
    "sigunguName": "춘천시",
    "south": 37.66064,
    "west": 127.49115,
    "north": 38.10003,
    "east": 128.04461
  },
  {
    "sidoCode": "51",
    "sigunguCode": "32020",
    "sidoName": "강원특별자치도",
    "sigunguName": "원주시",
    "south": 37.12841,
    "west": 127.7291,
    "north": 37.52191,
    "east": 128.2321
  },
  {
    "sidoCode": "51",
    "sigunguCode": "32030",
    "sidoName": "강원특별자치도",
    "sigunguName": "강릉시",
    "south": 37.4883,
    "west": 128.56536,
    "north": 37.93253,
    "east": 129.08988
  },
  {
    "sidoCode": "51",
    "sigunguCode": "32040",
    "sidoName": "강원특별자치도",
    "sigunguName": "동해시",
    "south": 37.4118,
    "west": 128.94262,
    "north": 37.61986,
    "east": 129.17477
  },
  {
    "sidoCode": "51",
    "sigunguCode": "32050",
    "sidoName": "강원특별자치도",
    "sigunguName": "태백시",
    "south": 37.04669,
    "west": 128.85408,
    "north": 37.36059,
    "east": 129.11066
  },
  {
    "sidoCode": "51",
    "sigunguCode": "32060",
    "sidoName": "강원특별자치도",
    "sigunguName": "속초시",
    "south": 38.10395,
    "west": 128.40614,
    "north": 38.24577,
    "east": 128.62982
  },
  {
    "sidoCode": "51",
    "sigunguCode": "32070",
    "sidoName": "강원특별자치도",
    "sigunguName": "삼척시",
    "south": 37.02367,
    "west": 128.83094,
    "north": 37.49124,
    "east": 129.38067
  },
  {
    "sidoCode": "51",
    "sigunguCode": "32310",
    "sidoName": "강원특별자치도",
    "sigunguName": "홍천군",
    "south": 37.5373,
    "west": 127.52024,
    "north": 37.96052,
    "east": 128.6038
  },
  {
    "sidoCode": "51",
    "sigunguCode": "32320",
    "sidoName": "강원특별자치도",
    "sigunguName": "횡성군",
    "south": 37.28378,
    "west": 127.74442,
    "north": 37.69516,
    "east": 128.31727
  },
  {
    "sidoCode": "51",
    "sigunguCode": "32330",
    "sidoName": "강원특별자치도",
    "sigunguName": "영월군",
    "south": 37.01283,
    "west": 128.09216,
    "north": 37.42371,
    "east": 128.92542
  },
  {
    "sidoCode": "51",
    "sigunguCode": "32340",
    "sidoName": "강원특별자치도",
    "sigunguName": "평창군",
    "south": 37.25163,
    "west": 128.22853,
    "north": 37.83639,
    "east": 128.78011
  },
  {
    "sidoCode": "51",
    "sigunguCode": "32350",
    "sidoName": "강원특별자치도",
    "sigunguName": "정선군",
    "south": 37.13208,
    "west": 128.49125,
    "north": 37.60792,
    "east": 129.00466
  },
  {
    "sidoCode": "51",
    "sigunguCode": "32360",
    "sidoName": "강원특별자치도",
    "sigunguName": "철원군",
    "south": 38.07477,
    "west": 127.08004,
    "north": 38.364,
    "east": 127.90347
  },
  {
    "sidoCode": "51",
    "sigunguCode": "32370",
    "sidoName": "강원특별자치도",
    "sigunguName": "화천군",
    "south": 37.97929,
    "west": 127.41553,
    "north": 38.30306,
    "east": 127.92864
  },
  {
    "sidoCode": "51",
    "sigunguCode": "32380",
    "sidoName": "강원특별자치도",
    "sigunguName": "양구군",
    "south": 37.98662,
    "west": 127.83675,
    "north": 38.34433,
    "east": 128.18739
  },
  {
    "sidoCode": "51",
    "sigunguCode": "32390",
    "sidoName": "강원특별자치도",
    "sigunguName": "인제군",
    "south": 37.79708,
    "west": 127.96251,
    "north": 38.40464,
    "east": 128.52857
  },
  {
    "sidoCode": "51",
    "sigunguCode": "32400",
    "sidoName": "강원특별자치도",
    "sigunguName": "고성군",
    "south": 38.17233,
    "west": 128.21115,
    "north": 38.62871,
    "east": 128.59993
  },
  {
    "sidoCode": "51",
    "sigunguCode": "32410",
    "sidoName": "강원특별자치도",
    "sigunguName": "양양군",
    "south": 37.84702,
    "west": 128.38925,
    "north": 38.17662,
    "east": 128.825
  },
  {
    "sidoCode": "43",
    "sigunguCode": "33020",
    "sidoName": "충청북도",
    "sigunguName": "충주시",
    "south": 36.78164,
    "west": 127.63585,
    "north": 37.22986,
    "east": 128.14904
  },
  {
    "sidoCode": "43",
    "sigunguCode": "33030",
    "sidoName": "충청북도",
    "sigunguName": "제천시",
    "south": 36.7967,
    "west": 127.90658,
    "north": 37.27333,
    "east": 128.34718
  },
  {
    "sidoCode": "43",
    "sigunguCode": "33041",
    "sidoName": "충청북도",
    "sigunguName": "청주시상당구",
    "south": 36.39321,
    "west": 127.43026,
    "north": 36.74499,
    "east": 127.78478
  },
  {
    "sidoCode": "43",
    "sigunguCode": "33042",
    "sidoName": "충청북도",
    "sigunguName": "청주시서원구",
    "south": 36.43419,
    "west": 127.35755,
    "north": 36.66146,
    "east": 127.51392
  },
  {
    "sidoCode": "43",
    "sigunguCode": "33043",
    "sidoName": "충청북도",
    "sigunguName": "청주시흥덕구",
    "south": 36.54668,
    "west": 127.26065,
    "north": 36.73991,
    "east": 127.49686
  },
  {
    "sidoCode": "43",
    "sigunguCode": "33044",
    "sidoName": "충청북도",
    "sigunguName": "청주시청원구",
    "south": 36.62984,
    "west": 127.30301,
    "north": 36.79526,
    "east": 127.63391
  },
  {
    "sidoCode": "43",
    "sigunguCode": "33320",
    "sidoName": "충청북도",
    "sigunguName": "보은군",
    "south": 36.35397,
    "west": 127.49951,
    "north": 36.62877,
    "east": 127.92134
  },
  {
    "sidoCode": "43",
    "sigunguCode": "33330",
    "sidoName": "충청북도",
    "sigunguName": "옥천군",
    "south": 36.15571,
    "west": 127.47105,
    "north": 36.46029,
    "east": 127.90626
  },
  {
    "sidoCode": "43",
    "sigunguCode": "33340",
    "sidoName": "충청북도",
    "sigunguName": "영동군",
    "south": 35.99723,
    "west": 127.57444,
    "north": 36.3316,
    "east": 128.07315
  },
  {
    "sidoCode": "43",
    "sigunguCode": "33350",
    "sidoName": "충청북도",
    "sigunguName": "진천군",
    "south": 36.73397,
    "west": 127.27283,
    "north": 37.02711,
    "east": 127.60016
  },
  {
    "sidoCode": "43",
    "sigunguCode": "33360",
    "sidoName": "충청북도",
    "sigunguName": "괴산군",
    "south": 36.58612,
    "west": 127.60546,
    "north": 36.96255,
    "east": 128.08772
  },
  {
    "sidoCode": "43",
    "sigunguCode": "33370",
    "sidoName": "충청북도",
    "sigunguName": "음성군",
    "south": 36.81883,
    "west": 127.43035,
    "north": 37.17029,
    "east": 127.81333
  },
  {
    "sidoCode": "43",
    "sigunguCode": "33380",
    "sidoName": "충청북도",
    "sigunguName": "단양군",
    "south": 36.78708,
    "west": 128.20212,
    "north": 37.17314,
    "east": 128.6671
  },
  {
    "sidoCode": "43",
    "sigunguCode": "33390",
    "sidoName": "충청북도",
    "sigunguName": "증평군",
    "south": 36.68628,
    "west": 127.52233,
    "north": 36.87508,
    "east": 127.6796
  },
  {
    "sidoCode": "44",
    "sigunguCode": "34011",
    "sidoName": "충청남도",
    "sigunguName": "천안시동남구",
    "south": 36.60475,
    "west": 126.99336,
    "north": 36.9072,
    "east": 127.43542
  },
  {
    "sidoCode": "44",
    "sigunguCode": "34012",
    "sidoName": "충청남도",
    "sigunguName": "천안시서북구",
    "south": 36.76993,
    "west": 127.05908,
    "north": 36.98647,
    "east": 127.30559
  },
  {
    "sidoCode": "44",
    "sigunguCode": "34020",
    "sidoName": "충청남도",
    "sigunguName": "공주시",
    "south": 36.26215,
    "west": 126.86857,
    "north": 36.69425,
    "east": 127.2973
  },
  {
    "sidoCode": "44",
    "sigunguCode": "34030",
    "sidoName": "충청남도",
    "sigunguName": "보령시",
    "south": 36.15728,
    "west": 125.94276,
    "north": 36.53898,
    "east": 126.75372
  },
  {
    "sidoCode": "44",
    "sigunguCode": "34040",
    "sidoName": "충청남도",
    "sigunguName": "아산시",
    "south": 36.63361,
    "west": 126.81409,
    "north": 36.95724,
    "east": 127.13471
  },
  {
    "sidoCode": "44",
    "sigunguCode": "34050",
    "sidoName": "충청남도",
    "sigunguName": "서산시",
    "south": 36.58534,
    "west": 126.30281,
    "north": 37.04165,
    "east": 126.66862
  },
  {
    "sidoCode": "44",
    "sigunguCode": "34060",
    "sidoName": "충청남도",
    "sigunguName": "논산시",
    "south": 36.04858,
    "west": 126.96902,
    "north": 36.35529,
    "east": 127.34857
  },
  {
    "sidoCode": "44",
    "sigunguCode": "34070",
    "sidoName": "충청남도",
    "sigunguName": "계룡시",
    "south": 36.2169,
    "west": 127.18137,
    "north": 36.36525,
    "east": 127.30694
  },
  {
    "sidoCode": "44",
    "sigunguCode": "34080",
    "sidoName": "충청남도",
    "sigunguName": "당진시",
    "south": 36.73426,
    "west": 126.40241,
    "north": 37.07994,
    "east": 126.87406
  },
  {
    "sidoCode": "44",
    "sigunguCode": "34310",
    "sidoName": "충청남도",
    "sigunguName": "금산군",
    "south": 35.96326,
    "west": 127.30338,
    "north": 36.28719,
    "east": 127.65475
  },
  {
    "sidoCode": "44",
    "sigunguCode": "34330",
    "sidoName": "충청남도",
    "sigunguName": "부여군",
    "south": 36.05657,
    "west": 126.66345,
    "north": 36.40204,
    "east": 127.08531
  },
  {
    "sidoCode": "44",
    "sigunguCode": "34340",
    "sidoName": "충청남도",
    "sigunguName": "서천군",
    "south": 35.97162,
    "west": 126.46921,
    "north": 36.20715,
    "east": 126.88609
  },
  {
    "sidoCode": "44",
    "sigunguCode": "34350",
    "sidoName": "충청남도",
    "sigunguName": "청양군",
    "south": 36.2995,
    "west": 126.65693,
    "north": 36.58681,
    "east": 127.04325
  },
  {
    "sidoCode": "44",
    "sigunguCode": "34360",
    "sidoName": "충청남도",
    "sigunguName": "홍성군",
    "south": 36.44473,
    "west": 126.41545,
    "north": 36.68758,
    "east": 126.78819
  },
  {
    "sidoCode": "44",
    "sigunguCode": "34370",
    "sidoName": "충청남도",
    "sigunguName": "예산군",
    "south": 36.51166,
    "west": 126.57032,
    "north": 36.81872,
    "east": 126.98734
  },
  {
    "sidoCode": "44",
    "sigunguCode": "34380",
    "sidoName": "충청남도",
    "sigunguName": "태안군",
    "south": 36.38418,
    "west": 125.5268,
    "north": 36.99348,
    "east": 126.45126
  },
  {
    "sidoCode": "52",
    "sigunguCode": "35011",
    "sidoName": "전북특별자치도",
    "sigunguName": "전주시완산구",
    "south": 35.71357,
    "west": 127.03542,
    "north": 35.85829,
    "east": 127.23202
  },
  {
    "sidoCode": "52",
    "sigunguCode": "35012",
    "sidoName": "전북특별자치도",
    "sigunguName": "전주시덕진구",
    "south": 35.78665,
    "west": 126.98284,
    "north": 35.91811,
    "east": 127.24929
  },
  {
    "sidoCode": "52",
    "sigunguCode": "35020",
    "sidoName": "전북특별자치도",
    "sigunguName": "군산시",
    "south": 35.6593,
    "west": 125.9516,
    "north": 36.14239,
    "east": 126.9304
  },
  {
    "sidoCode": "52",
    "sigunguCode": "35030",
    "sidoName": "전북특별자치도",
    "sigunguName": "익산시",
    "south": 35.86849,
    "west": 126.83641,
    "north": 36.17157,
    "east": 127.15472
  },
  {
    "sidoCode": "52",
    "sigunguCode": "35040",
    "sidoName": "전북특별자치도",
    "sigunguName": "정읍시",
    "south": 35.44621,
    "west": 126.70052,
    "north": 35.77373,
    "east": 127.13194
  },
  {
    "sidoCode": "52",
    "sigunguCode": "35050",
    "sidoName": "전북특별자치도",
    "sigunguName": "남원시",
    "south": 35.28746,
    "west": 127.16891,
    "north": 35.57582,
    "east": 127.68907
  },
  {
    "sidoCode": "52",
    "sigunguCode": "35060",
    "sidoName": "전북특별자치도",
    "sigunguName": "김제시",
    "south": 35.65116,
    "west": 126.66149,
    "north": 35.93271,
    "east": 127.10168
  },
  {
    "sidoCode": "52",
    "sigunguCode": "35310",
    "sidoName": "전북특별자치도",
    "sigunguName": "완주군",
    "south": 35.60389,
    "west": 126.98015,
    "north": 36.14584,
    "east": 127.39321
  },
  {
    "sidoCode": "52",
    "sigunguCode": "35320",
    "sidoName": "전북특별자치도",
    "sigunguName": "진안군",
    "south": 35.6037,
    "west": 127.2503,
    "north": 36.0445,
    "east": 127.63984
  },
  {
    "sidoCode": "52",
    "sigunguCode": "35330",
    "sidoName": "전북특별자치도",
    "sigunguName": "무주군",
    "south": 35.77323,
    "west": 127.50937,
    "north": 36.0836,
    "east": 127.92637
  },
  {
    "sidoCode": "52",
    "sigunguCode": "35340",
    "sidoName": "전북특별자치도",
    "sigunguName": "장수군",
    "south": 35.45281,
    "west": 127.34718,
    "north": 35.85394,
    "east": 127.71474
  },
  {
    "sidoCode": "52",
    "sigunguCode": "35350",
    "sidoName": "전북특별자치도",
    "sigunguName": "임실군",
    "south": 35.44479,
    "west": 127.0681,
    "north": 35.79265,
    "east": 127.45129
  },
  {
    "sidoCode": "52",
    "sigunguCode": "35360",
    "sidoName": "전북특별자치도",
    "sigunguName": "순창군",
    "south": 35.28423,
    "west": 126.84474,
    "north": 35.57113,
    "east": 127.32927
  },
  {
    "sidoCode": "52",
    "sigunguCode": "35370",
    "sidoName": "전북특별자치도",
    "sigunguName": "고창군",
    "south": 35.28579,
    "west": 126.40822,
    "north": 35.58982,
    "east": 126.78861
  },
  {
    "sidoCode": "52",
    "sigunguCode": "35380",
    "sidoName": "전북특별자치도",
    "sigunguName": "부안군",
    "south": 35.55167,
    "west": 126.08521,
    "north": 35.82787,
    "east": 126.85591
  },
  {
    "sidoCode": "46",
    "sigunguCode": "36010",
    "sidoName": "전라남도",
    "sigunguName": "목포시",
    "south": 34.72978,
    "west": 126.27335,
    "north": 34.8592,
    "east": 126.47444
  },
  {
    "sidoCode": "46",
    "sigunguCode": "36020",
    "sidoName": "전라남도",
    "sigunguName": "여수시",
    "south": 33.99091,
    "west": 127.20264,
    "north": 34.91413,
    "east": 127.92018
  },
  {
    "sidoCode": "46",
    "sigunguCode": "36030",
    "sidoName": "전라남도",
    "sigunguName": "순천시",
    "south": 34.81705,
    "west": 127.15984,
    "north": 35.20412,
    "east": 127.60969
  },
  {
    "sidoCode": "46",
    "sigunguCode": "36040",
    "sidoName": "전라남도",
    "sigunguName": "나주시",
    "south": 34.85294,
    "west": 126.49831,
    "north": 35.12986,
    "east": 126.9142
  },
  {
    "sidoCode": "46",
    "sigunguCode": "36060",
    "sidoName": "전라남도",
    "sigunguName": "광양시",
    "south": 34.86878,
    "west": 127.5105,
    "north": 35.19757,
    "east": 127.80177
  },
  {
    "sidoCode": "46",
    "sigunguCode": "36310",
    "sidoName": "전라남도",
    "sigunguName": "담양군",
    "south": 35.10095,
    "west": 126.8392,
    "north": 35.48157,
    "east": 127.133
  },
  {
    "sidoCode": "46",
    "sigunguCode": "36320",
    "sidoName": "전라남도",
    "sigunguName": "곡성군",
    "south": 35.05436,
    "west": 127.06623,
    "north": 35.35195,
    "east": 127.42728
  },
  {
    "sidoCode": "46",
    "sigunguCode": "36330",
    "sidoName": "전라남도",
    "sigunguName": "구례군",
    "south": 35.08029,
    "west": 127.35189,
    "north": 35.38034,
    "east": 127.63962
  },
  {
    "sidoCode": "46",
    "sigunguCode": "36350",
    "sidoName": "전라남도",
    "sigunguName": "고흥군",
    "south": 34.30227,
    "west": 127.06673,
    "north": 34.84274,
    "east": 127.55999
  },
  {
    "sidoCode": "46",
    "sigunguCode": "36360",
    "sidoName": "전라남도",
    "sigunguName": "보성군",
    "south": 34.61997,
    "west": 126.95684,
    "north": 35.00253,
    "east": 127.49136
  },
  {
    "sidoCode": "46",
    "sigunguCode": "36370",
    "sidoName": "전라남도",
    "sigunguName": "화순군",
    "south": 34.8087,
    "west": 126.80888,
    "north": 35.22929,
    "east": 127.21604
  },
  {
    "sidoCode": "46",
    "sigunguCode": "36380",
    "sidoName": "전라남도",
    "sigunguName": "장흥군",
    "south": 34.40698,
    "west": 126.77793,
    "north": 34.89283,
    "east": 127.06121
  },
  {
    "sidoCode": "46",
    "sigunguCode": "36390",
    "sidoName": "전라남도",
    "sigunguName": "강진군",
    "south": 34.43274,
    "west": 126.64148,
    "north": 34.80144,
    "east": 126.90085
  },
  {
    "sidoCode": "46",
    "sigunguCode": "36400",
    "sidoName": "전라남도",
    "sigunguName": "해남군",
    "south": 34.27726,
    "west": 126.22416,
    "north": 34.77739,
    "east": 126.74986
  },
  {
    "sidoCode": "46",
    "sigunguCode": "36410",
    "sidoName": "전라남도",
    "sigunguName": "영암군",
    "south": 34.64284,
    "west": 126.34556,
    "north": 34.96123,
    "east": 126.87429
  },
  {
    "sidoCode": "46",
    "sigunguCode": "36420",
    "sidoName": "전라남도",
    "sigunguName": "무안군",
    "south": 34.75347,
    "west": 126.22834,
    "north": 35.18231,
    "east": 126.572
  },
  {
    "sidoCode": "46",
    "sigunguCode": "36430",
    "sidoName": "전라남도",
    "sigunguName": "함평군",
    "south": 34.95851,
    "west": 126.35532,
    "north": 35.25058,
    "east": 126.68712
  },
  {
    "sidoCode": "46",
    "sigunguCode": "36440",
    "sidoName": "전라남도",
    "sigunguName": "영광군",
    "south": 35.14869,
    "west": 125.97004,
    "north": 35.4477,
    "east": 126.6598
  },
  {
    "sidoCode": "46",
    "sigunguCode": "36450",
    "sidoName": "전라남도",
    "sigunguName": "장성군",
    "south": 35.17572,
    "west": 126.56832,
    "north": 35.50191,
    "east": 126.94066
  },
  {
    "sidoCode": "46",
    "sigunguCode": "36460",
    "sidoName": "전라남도",
    "sigunguName": "완도군",
    "south": 33.95357,
    "west": 126.36549,
    "north": 34.475,
    "east": 127.21623
  },
  {
    "sidoCode": "46",
    "sigunguCode": "36470",
    "sidoName": "전라남도",
    "sigunguName": "진도군",
    "south": 34.12572,
    "west": 125.82553,
    "north": 34.60408,
    "east": 126.40002
  },
  {
    "sidoCode": "46",
    "sigunguCode": "36480",
    "sidoName": "전라남도",
    "sigunguName": "신안군",
    "south": 34.03253,
    "west": 125.06647,
    "north": 35.22809,
    "east": 126.3938
  },
  {
    "sidoCode": "47",
    "sigunguCode": "37011",
    "sidoName": "경상북도",
    "sigunguName": "포항시남구",
    "south": 35.82334,
    "west": 129.26182,
    "north": 36.10109,
    "east": 129.59942
  },
  {
    "sidoCode": "47",
    "sigunguCode": "37012",
    "sidoName": "경상북도",
    "sigunguName": "포항시북구",
    "south": 35.99915,
    "west": 128.97449,
    "north": 36.34837,
    "east": 129.47939
  },
  {
    "sidoCode": "47",
    "sigunguCode": "37020",
    "sidoName": "경상북도",
    "sigunguName": "경주시",
    "south": 35.62536,
    "west": 128.95573,
    "north": 36.0947,
    "east": 129.5356
  },
  {
    "sidoCode": "47",
    "sigunguCode": "37030",
    "sidoName": "경상북도",
    "sigunguName": "김천시",
    "south": 35.81393,
    "west": 127.86027,
    "north": 36.27308,
    "east": 128.31623
  },
  {
    "sidoCode": "47",
    "sigunguCode": "37040",
    "sidoName": "경상북도",
    "sigunguName": "안동시",
    "south": 36.28072,
    "west": 128.41349,
    "north": 36.83816,
    "east": 129.01575
  },
  {
    "sidoCode": "47",
    "sigunguCode": "37050",
    "sidoName": "경상북도",
    "sigunguName": "구미시",
    "south": 36.04558,
    "west": 128.11778,
    "north": 36.37747,
    "east": 128.579
  },
  {
    "sidoCode": "47",
    "sigunguCode": "37060",
    "sidoName": "경상북도",
    "sigunguName": "영주시",
    "south": 36.68091,
    "west": 128.40897,
    "north": 37.08051,
    "east": 128.76057
  },
  {
    "sidoCode": "47",
    "sigunguCode": "37070",
    "sidoName": "경상북도",
    "sigunguName": "영천시",
    "south": 35.81572,
    "west": 128.67916,
    "north": 36.19959,
    "east": 129.16633
  },
  {
    "sidoCode": "47",
    "sigunguCode": "37080",
    "sidoName": "경상북도",
    "sigunguName": "상주시",
    "south": 36.22216,
    "west": 127.78115,
    "north": 36.67177,
    "east": 128.35404
  },
  {
    "sidoCode": "47",
    "sigunguCode": "37090",
    "sidoName": "경상북도",
    "sigunguName": "문경시",
    "south": 36.49802,
    "west": 127.85929,
    "north": 36.88733,
    "east": 128.38705
  },
  {
    "sidoCode": "47",
    "sigunguCode": "37100",
    "sidoName": "경상북도",
    "sigunguName": "경산시",
    "south": 35.6855,
    "west": 128.6664,
    "north": 36.00892,
    "east": 128.98592
  },
  {
    "sidoCode": "47",
    "sigunguCode": "37310",
    "sidoName": "경상북도",
    "sigunguName": "군위군",
    "south": 35.99231,
    "west": 128.39544,
    "north": 36.34224,
    "east": 128.9152
  },
  {
    "sidoCode": "47",
    "sigunguCode": "37320",
    "sidoName": "경상북도",
    "sigunguName": "의성군",
    "south": 36.17571,
    "west": 128.27268,
    "north": 36.54759,
    "east": 128.91162
  },
  {
    "sidoCode": "47",
    "sigunguCode": "37330",
    "sidoName": "경상북도",
    "sigunguName": "청송군",
    "south": 36.14627,
    "west": 128.83189,
    "north": 36.6098,
    "east": 129.26921
  },
  {
    "sidoCode": "47",
    "sigunguCode": "37340",
    "sidoName": "경상북도",
    "sigunguName": "영양군",
    "south": 36.47392,
    "west": 128.96878,
    "north": 36.89655,
    "east": 129.3291
  },
  {
    "sidoCode": "47",
    "sigunguCode": "37350",
    "sidoName": "경상북도",
    "sigunguName": "영덕군",
    "south": 36.25156,
    "west": 129.13271,
    "north": 36.68887,
    "east": 129.4683
  },
  {
    "sidoCode": "47",
    "sigunguCode": "37360",
    "sidoName": "경상북도",
    "sigunguName": "청도군",
    "south": 35.55189,
    "west": 128.51181,
    "north": 35.8612,
    "east": 129.0619
  },
  {
    "sidoCode": "47",
    "sigunguCode": "37370",
    "sidoName": "경상북도",
    "sigunguName": "고령군",
    "south": 35.59588,
    "west": 128.14433,
    "north": 35.86741,
    "east": 128.49807
  },
  {
    "sidoCode": "47",
    "sigunguCode": "37380",
    "sidoName": "경상북도",
    "sigunguName": "성주군",
    "south": 35.76219,
    "west": 128.03165,
    "north": 36.0704,
    "east": 128.41413
  },
  {
    "sidoCode": "47",
    "sigunguCode": "37390",
    "sidoName": "경상북도",
    "sigunguName": "칠곡군",
    "south": 35.87145,
    "west": 128.26996,
    "north": 36.13985,
    "east": 128.65572
  },
  {
    "sidoCode": "47",
    "sigunguCode": "37400",
    "sidoName": "경상북도",
    "sigunguName": "예천군",
    "south": 36.43946,
    "west": 128.24677,
    "north": 36.86361,
    "east": 128.62467
  },
  {
    "sidoCode": "47",
    "sigunguCode": "37410",
    "sidoName": "경상북도",
    "sigunguName": "봉화군",
    "south": 36.7319,
    "west": 128.62263,
    "north": 37.11541,
    "east": 129.20041
  },
  {
    "sidoCode": "47",
    "sigunguCode": "37420",
    "sidoName": "경상북도",
    "sigunguName": "울진군",
    "south": 36.6285,
    "west": 129.06166,
    "north": 37.16183,
    "east": 129.49322
  },
  {
    "sidoCode": "47",
    "sigunguCode": "37430",
    "sidoName": "경상북도",
    "sigunguName": "울릉군",
    "south": 37.22313,
    "west": 130.77658,
    "north": 37.56414,
    "east": 131.88647
  },
  {
    "sidoCode": "48",
    "sigunguCode": "38030",
    "sidoName": "경상남도",
    "sigunguName": "진주시",
    "south": 35.03592,
    "west": 127.87282,
    "north": 35.36581,
    "east": 128.3832
  },
  {
    "sidoCode": "48",
    "sigunguCode": "38050",
    "sidoName": "경상남도",
    "sigunguName": "통영시",
    "south": 34.51968,
    "west": 128.10957,
    "north": 34.99138,
    "east": 128.74978
  },
  {
    "sidoCode": "48",
    "sigunguCode": "38060",
    "sidoName": "경상남도",
    "sigunguName": "사천시",
    "south": 34.87101,
    "west": 127.86398,
    "north": 35.17385,
    "east": 128.19932
  },
  {
    "sidoCode": "48",
    "sigunguCode": "38070",
    "sidoName": "경상남도",
    "sigunguName": "김해시",
    "south": 35.13546,
    "west": 128.67708,
    "north": 35.41055,
    "east": 129.02982
  },
  {
    "sidoCode": "48",
    "sigunguCode": "38080",
    "sidoName": "경상남도",
    "sigunguName": "밀양시",
    "south": 35.33051,
    "west": 128.55617,
    "north": 35.65562,
    "east": 129.03962
  },
  {
    "sidoCode": "48",
    "sigunguCode": "38090",
    "sidoName": "경상남도",
    "sigunguName": "거제시",
    "south": 34.6668,
    "west": 128.44035,
    "north": 35.05575,
    "east": 128.76987
  },
  {
    "sidoCode": "48",
    "sigunguCode": "38100",
    "sidoName": "경상남도",
    "sigunguName": "양산시",
    "south": 35.25876,
    "west": 128.85907,
    "north": 35.54727,
    "east": 129.23407
  },
  {
    "sidoCode": "48",
    "sigunguCode": "38111",
    "sidoName": "경상남도",
    "sigunguName": "창원시의창구",
    "south": 35.20211,
    "west": 128.54429,
    "north": 35.40838,
    "east": 128.77912
  },
  {
    "sidoCode": "48",
    "sigunguCode": "38112",
    "sidoName": "경상남도",
    "sigunguName": "창원시성산구",
    "south": 35.13598,
    "west": 128.57425,
    "north": 35.261,
    "east": 128.76639
  },
  {
    "sidoCode": "48",
    "sigunguCode": "38113",
    "sidoName": "경상남도",
    "sigunguName": "창원시마산합포구",
    "south": 35.03713,
    "west": 128.33314,
    "north": 35.23741,
    "east": 128.65503
  },
  {
    "sidoCode": "48",
    "sigunguCode": "38114",
    "sidoName": "경상남도",
    "sigunguName": "창원시마산회원구",
    "south": 35.16209,
    "west": 128.45917,
    "north": 35.29208,
    "east": 128.64194
  },
  {
    "sidoCode": "48",
    "sigunguCode": "38115",
    "sidoName": "경상남도",
    "sigunguName": "창원시진해구",
    "south": 35.04088,
    "west": 128.59184,
    "north": 35.19594,
    "east": 128.85827
  },
  {
    "sidoCode": "48",
    "sigunguCode": "38310",
    "sidoName": "경상남도",
    "sigunguName": "의령군",
    "south": 35.23837,
    "west": 128.06765,
    "north": 35.53238,
    "east": 128.45245
  },
  {
    "sidoCode": "48",
    "sigunguCode": "38320",
    "sidoName": "경상남도",
    "sigunguName": "함안군",
    "south": 35.14901,
    "west": 128.25904,
    "north": 35.41651,
    "east": 128.60665
  },
  {
    "sidoCode": "48",
    "sigunguCode": "38330",
    "sidoName": "경상남도",
    "sigunguName": "창녕군",
    "south": 35.35357,
    "west": 128.33562,
    "north": 35.69816,
    "east": 128.66664
  },
  {
    "sidoCode": "48",
    "sigunguCode": "38340",
    "sidoName": "경상남도",
    "sigunguName": "고성군",
    "south": 34.86098,
    "west": 128.0859,
    "north": 35.14744,
    "east": 128.51662
  },
  {
    "sidoCode": "48",
    "sigunguCode": "38350",
    "sidoName": "경상남도",
    "sigunguName": "남해군",
    "south": 34.66462,
    "west": 127.79271,
    "north": 34.96199,
    "east": 128.10183
  },
  {
    "sidoCode": "48",
    "sigunguCode": "38360",
    "sidoName": "경상남도",
    "sigunguName": "하동군",
    "south": 34.90805,
    "west": 127.56107,
    "north": 35.34756,
    "east": 127.95425
  },
  {
    "sidoCode": "48",
    "sigunguCode": "38370",
    "sidoName": "경상남도",
    "sigunguName": "산청군",
    "south": 35.20427,
    "west": 127.67291,
    "north": 35.59121,
    "east": 128.1302
  },
  {
    "sidoCode": "48",
    "sigunguCode": "38380",
    "sidoName": "경상남도",
    "sigunguName": "함양군",
    "south": 35.30076,
    "west": 127.56986,
    "north": 35.78637,
    "east": 127.89292
  },
  {
    "sidoCode": "48",
    "sigunguCode": "38390",
    "sidoName": "경상남도",
    "sigunguName": "거창군",
    "south": 35.49943,
    "west": 127.66444,
    "north": 35.92494,
    "east": 128.11018
  },
  {
    "sidoCode": "48",
    "sigunguCode": "38400",
    "sidoName": "경상남도",
    "sigunguName": "합천군",
    "south": 35.3529,
    "west": 127.93823,
    "north": 35.84727,
    "east": 128.39486
  },
  {
    "sidoCode": "50",
    "sigunguCode": "39010",
    "sidoName": "제주특별자치도",
    "sigunguName": "제주시",
    "south": 33.25796,
    "west": 126.12869,
    "north": 34.02787,
    "east": 126.98766
  },
  {
    "sidoCode": "50",
    "sigunguCode": "39020",
    "sidoName": "제주특별자치도",
    "sigunguName": "서귀포시",
    "south": 33.09736,
    "west": 126.15372,
    "north": 33.49797,
    "east": 126.96142
  }
];

export const ORG_CODE_TO_REGION: Readonly<Record<string, OrgRegionInfo>> = {
  "3000000": {
    "sidoCode": "11",
    "sigunguCode": "11010",
    "sidoName": "서울특별시",
    "sigunguName": "종로구"
  },
  "3010000": {
    "sidoCode": "11",
    "sigunguCode": "11020",
    "sidoName": "서울특별시",
    "sigunguName": "중구"
  },
  "3020000": {
    "sidoCode": "11",
    "sigunguCode": "11030",
    "sidoName": "서울특별시",
    "sigunguName": "용산구"
  },
  "3030000": {
    "sidoCode": "11",
    "sigunguCode": "11040",
    "sidoName": "서울특별시",
    "sigunguName": "성동구"
  },
  "3040000": {
    "sidoCode": "11",
    "sigunguCode": "11050",
    "sidoName": "서울특별시",
    "sigunguName": "광진구"
  },
  "3050000": {
    "sidoCode": "11",
    "sigunguCode": "11060",
    "sidoName": "서울특별시",
    "sigunguName": "동대문구"
  },
  "3060000": {
    "sidoCode": "11",
    "sigunguCode": "11070",
    "sidoName": "서울특별시",
    "sigunguName": "중랑구"
  },
  "3070000": {
    "sidoCode": "11",
    "sigunguCode": "11080",
    "sidoName": "서울특별시",
    "sigunguName": "성북구"
  },
  "3080000": {
    "sidoCode": "11",
    "sigunguCode": "11090",
    "sidoName": "서울특별시",
    "sigunguName": "강북구"
  },
  "3090000": {
    "sidoCode": "11",
    "sigunguCode": "11100",
    "sidoName": "서울특별시",
    "sigunguName": "도봉구"
  },
  "3100000": {
    "sidoCode": "11",
    "sigunguCode": "11110",
    "sidoName": "서울특별시",
    "sigunguName": "노원구"
  },
  "3110000": {
    "sidoCode": "11",
    "sigunguCode": "11120",
    "sidoName": "서울특별시",
    "sigunguName": "은평구"
  },
  "3120000": {
    "sidoCode": "11",
    "sigunguCode": "11130",
    "sidoName": "서울특별시",
    "sigunguName": "서대문구"
  },
  "3130000": {
    "sidoCode": "11",
    "sigunguCode": "11140",
    "sidoName": "서울특별시",
    "sigunguName": "마포구"
  },
  "3140000": {
    "sidoCode": "11",
    "sigunguCode": "11150",
    "sidoName": "서울특별시",
    "sigunguName": "양천구"
  },
  "3150000": {
    "sidoCode": "11",
    "sigunguCode": "11160",
    "sidoName": "서울특별시",
    "sigunguName": "강서구"
  },
  "3160000": {
    "sidoCode": "11",
    "sigunguCode": "11170",
    "sidoName": "서울특별시",
    "sigunguName": "구로구"
  },
  "3170000": {
    "sidoCode": "11",
    "sigunguCode": "11180",
    "sidoName": "서울특별시",
    "sigunguName": "금천구"
  },
  "3180000": {
    "sidoCode": "11",
    "sigunguCode": "11190",
    "sidoName": "서울특별시",
    "sigunguName": "영등포구"
  },
  "3190000": {
    "sidoCode": "11",
    "sigunguCode": "11200",
    "sidoName": "서울특별시",
    "sigunguName": "동작구"
  },
  "3200000": {
    "sidoCode": "11",
    "sigunguCode": "11210",
    "sidoName": "서울특별시",
    "sigunguName": "관악구"
  },
  "3210000": {
    "sidoCode": "11",
    "sigunguCode": "11220",
    "sidoName": "서울특별시",
    "sigunguName": "서초구"
  },
  "3220000": {
    "sidoCode": "11",
    "sigunguCode": "11230",
    "sidoName": "서울특별시",
    "sigunguName": "강남구"
  },
  "3230000": {
    "sidoCode": "11",
    "sigunguCode": "11240",
    "sidoName": "서울특별시",
    "sigunguName": "송파구"
  },
  "3240000": {
    "sidoCode": "11",
    "sigunguCode": "11250",
    "sidoName": "서울특별시",
    "sigunguName": "강동구"
  },
  "3250000": {
    "sidoCode": "26",
    "sigunguCode": "21010",
    "sidoName": "부산광역시",
    "sigunguName": "중구"
  },
  "3260000": {
    "sidoCode": "26",
    "sigunguCode": "21020",
    "sidoName": "부산광역시",
    "sigunguName": "서구"
  },
  "3270000": {
    "sidoCode": "26",
    "sigunguCode": "21030",
    "sidoName": "부산광역시",
    "sigunguName": "동구"
  },
  "3280000": {
    "sidoCode": "26",
    "sigunguCode": "21040",
    "sidoName": "부산광역시",
    "sigunguName": "영도구"
  },
  "3290000": {
    "sidoCode": "26",
    "sigunguCode": "21050",
    "sidoName": "부산광역시",
    "sigunguName": "부산진구"
  },
  "3300000": {
    "sidoCode": "26",
    "sigunguCode": "21060",
    "sidoName": "부산광역시",
    "sigunguName": "동래구"
  },
  "3310000": {
    "sidoCode": "26",
    "sigunguCode": "21070",
    "sidoName": "부산광역시",
    "sigunguName": "남구"
  },
  "3320000": {
    "sidoCode": "26",
    "sigunguCode": "21080",
    "sidoName": "부산광역시",
    "sigunguName": "북구"
  },
  "3330000": {
    "sidoCode": "26",
    "sigunguCode": "21090",
    "sidoName": "부산광역시",
    "sigunguName": "해운대구"
  },
  "3340000": {
    "sidoCode": "26",
    "sigunguCode": "21100",
    "sidoName": "부산광역시",
    "sigunguName": "사하구"
  },
  "3350000": {
    "sidoCode": "26",
    "sigunguCode": "21110",
    "sidoName": "부산광역시",
    "sigunguName": "금정구"
  },
  "3360000": {
    "sidoCode": "26",
    "sigunguCode": "21120",
    "sidoName": "부산광역시",
    "sigunguName": "강서구"
  },
  "3370000": {
    "sidoCode": "26",
    "sigunguCode": "21130",
    "sidoName": "부산광역시",
    "sigunguName": "연제구"
  },
  "3380000": {
    "sidoCode": "26",
    "sigunguCode": "21140",
    "sidoName": "부산광역시",
    "sigunguName": "수영구"
  },
  "3390000": {
    "sidoCode": "26",
    "sigunguCode": "21150",
    "sidoName": "부산광역시",
    "sigunguName": "사상구"
  },
  "3400000": {
    "sidoCode": "26",
    "sigunguCode": "21310",
    "sidoName": "부산광역시",
    "sigunguName": "기장군"
  },
  "3410000": {
    "sidoCode": "27",
    "sigunguCode": "22010",
    "sidoName": "대구광역시",
    "sigunguName": "중구"
  },
  "3420000": {
    "sidoCode": "27",
    "sigunguCode": "22020",
    "sidoName": "대구광역시",
    "sigunguName": "동구"
  },
  "3430000": {
    "sidoCode": "27",
    "sigunguCode": "22030",
    "sidoName": "대구광역시",
    "sigunguName": "서구"
  },
  "3440000": {
    "sidoCode": "27",
    "sigunguCode": "22040",
    "sidoName": "대구광역시",
    "sigunguName": "남구"
  },
  "3450000": {
    "sidoCode": "27",
    "sigunguCode": "22050",
    "sidoName": "대구광역시",
    "sigunguName": "북구"
  },
  "3460000": {
    "sidoCode": "27",
    "sigunguCode": "22060",
    "sidoName": "대구광역시",
    "sigunguName": "수성구"
  },
  "3470000": {
    "sidoCode": "27",
    "sigunguCode": "22070",
    "sidoName": "대구광역시",
    "sigunguName": "달서구"
  },
  "3480000": {
    "sidoCode": "27",
    "sigunguCode": "22310",
    "sidoName": "대구광역시",
    "sigunguName": "달성군"
  },
  "3491000": {
    "sidoCode": "28",
    "sigunguCode": "23010",
    "sidoName": "인천광역시",
    "sigunguName": "영종구"
  },
  "3501000": {
    "sidoCode": "28",
    "sigunguCode": "23010",
    "sidoName": "인천광역시",
    "sigunguName": "제물포구"
  },
  "3510500": {
    "sidoCode": "28",
    "sigunguCode": "23030",
    "sidoName": "인천광역시",
    "sigunguName": "미추홀구"
  },
  "3520000": {
    "sidoCode": "28",
    "sigunguCode": "23040",
    "sidoName": "인천광역시",
    "sigunguName": "연수구"
  },
  "3530000": {
    "sidoCode": "28",
    "sigunguCode": "23080",
    "sidoName": "인천광역시",
    "sigunguName": "서구"
  },
  "3540000": {
    "sidoCode": "28",
    "sigunguCode": "23060",
    "sidoName": "인천광역시",
    "sigunguName": "부평구"
  },
  "3550000": {
    "sidoCode": "28",
    "sigunguCode": "23070",
    "sidoName": "인천광역시",
    "sigunguName": "계양구"
  },
  "3561000": {
    "sidoCode": "28",
    "sigunguCode": "23080",
    "sidoName": "인천광역시",
    "sigunguName": "서해구"
  },
  "3565000": {
    "sidoCode": "28",
    "sigunguCode": "23080",
    "sidoName": "인천광역시",
    "sigunguName": "검단구"
  },
  "3570000": {
    "sidoCode": "28",
    "sigunguCode": "23310",
    "sidoName": "인천광역시",
    "sigunguName": "강화군"
  },
  "3580000": {
    "sidoCode": "28",
    "sigunguCode": "23080",
    "sidoName": "인천광역시",
    "sigunguName": "서구"
  },
  "3640000": {
    "sidoCode": "30",
    "sigunguCode": "25010",
    "sidoName": "대전광역시",
    "sigunguName": "동구"
  },
  "3650000": {
    "sidoCode": "30",
    "sigunguCode": "25020",
    "sidoName": "대전광역시",
    "sigunguName": "중구"
  },
  "3660000": {
    "sidoCode": "30",
    "sigunguCode": "25030",
    "sidoName": "대전광역시",
    "sigunguName": "서구"
  },
  "3670000": {
    "sidoCode": "30",
    "sigunguCode": "25040",
    "sidoName": "대전광역시",
    "sigunguName": "유성구"
  },
  "3680000": {
    "sidoCode": "30",
    "sigunguCode": "25050",
    "sidoName": "대전광역시",
    "sigunguName": "대덕구"
  },
  "3690000": {
    "sidoCode": "31",
    "sigunguCode": "26010",
    "sidoName": "울산광역시",
    "sigunguName": "중구"
  },
  "3700000": {
    "sidoCode": "31",
    "sigunguCode": "26020",
    "sidoName": "울산광역시",
    "sigunguName": "남구"
  },
  "3710000": {
    "sidoCode": "31",
    "sigunguCode": "26030",
    "sidoName": "울산광역시",
    "sigunguName": "동구"
  },
  "3720000": {
    "sidoCode": "31",
    "sigunguCode": "26040",
    "sidoName": "울산광역시",
    "sigunguName": "북구"
  },
  "3730000": {
    "sidoCode": "31",
    "sigunguCode": "26310",
    "sidoName": "울산광역시",
    "sigunguName": "울주군"
  },
  "3740000": {
    "sidoCode": "41",
    "sigunguCode": "31013",
    "sidoName": "경기도",
    "sigunguName": "수원시 팔달구"
  },
  "3780000": {
    "sidoCode": "41",
    "sigunguCode": "31023",
    "sidoName": "경기도",
    "sigunguName": "성남시 분당구"
  },
  "3820000": {
    "sidoCode": "41",
    "sigunguCode": "31030",
    "sidoName": "경기도",
    "sigunguName": "의정부시"
  },
  "3830000": {
    "sidoCode": "41",
    "sigunguCode": "31042",
    "sidoName": "경기도",
    "sigunguName": "안양시 동안구"
  },
  "3860000": {
    "sidoCode": "41",
    "sigunguCode": "31050",
    "sidoName": "경기도",
    "sigunguName": "부천시 원미구"
  },
  "3900000": {
    "sidoCode": "41",
    "sigunguCode": "31060",
    "sidoName": "경기도",
    "sigunguName": "광명시"
  },
  "3910000": {
    "sidoCode": "41",
    "sigunguCode": "31070",
    "sidoName": "경기도",
    "sigunguName": "평택시"
  },
  "3920000": {
    "sidoCode": "41",
    "sigunguCode": "31080",
    "sidoName": "경기도",
    "sigunguName": "동두천시"
  },
  "3930000": {
    "sidoCode": "41",
    "sigunguCode": "31092",
    "sidoName": "경기도",
    "sigunguName": "안산시 단원구"
  },
  "3940000": {
    "sidoCode": "41",
    "sigunguCode": "31104",
    "sidoName": "경기도",
    "sigunguName": "고양시 일산서구"
  },
  "3970000": {
    "sidoCode": "41",
    "sigunguCode": "31110",
    "sidoName": "경기도",
    "sigunguName": "과천시"
  },
  "3980000": {
    "sidoCode": "41",
    "sigunguCode": "31120",
    "sidoName": "경기도",
    "sigunguName": "구리시"
  },
  "3990000": {
    "sidoCode": "41",
    "sigunguCode": "31130",
    "sidoName": "경기도",
    "sigunguName": "남양주시"
  },
  "4000000": {
    "sidoCode": "41",
    "sigunguCode": "31140",
    "sidoName": "경기도",
    "sigunguName": "오산시"
  },
  "4010000": {
    "sidoCode": "41",
    "sigunguCode": "31150",
    "sidoName": "경기도",
    "sigunguName": "시흥시"
  },
  "4030000": {
    "sidoCode": "41",
    "sigunguCode": "31170",
    "sidoName": "경기도",
    "sigunguName": "의왕시"
  },
  "4040000": {
    "sidoCode": "41",
    "sigunguCode": "31180",
    "sidoName": "경기도",
    "sigunguName": "하남시"
  },
  "4050000": {
    "sidoCode": "41",
    "sigunguCode": "31193",
    "sidoName": "경기도",
    "sigunguName": "용인시 수지구"
  },
  "4060000": {
    "sidoCode": "41",
    "sigunguCode": "31200",
    "sidoName": "경기도",
    "sigunguName": "파주시"
  },
  "4070000": {
    "sidoCode": "41",
    "sigunguCode": "31210",
    "sidoName": "경기도",
    "sigunguName": "이천시"
  },
  "4080000": {
    "sidoCode": "41",
    "sigunguCode": "31220",
    "sidoName": "경기도",
    "sigunguName": "안성시"
  },
  "4090000": {
    "sidoCode": "41",
    "sigunguCode": "31230",
    "sidoName": "경기도",
    "sigunguName": "김포시"
  },
  "4140000": {
    "sidoCode": "41",
    "sigunguCode": "31350",
    "sidoName": "경기도",
    "sigunguName": "연천군"
  },
  "4160000": {
    "sidoCode": "41",
    "sigunguCode": "31370",
    "sidoName": "경기도",
    "sigunguName": "가평군"
  },
  "4170000": {
    "sidoCode": "41",
    "sigunguCode": "31380",
    "sidoName": "경기도",
    "sigunguName": "양평군"
  },
  "4181000": {
    "sidoCode": "51",
    "sigunguCode": "32010",
    "sidoName": "강원특별자치도",
    "sigunguName": "춘천시"
  },
  "4191000": {
    "sidoCode": "51",
    "sigunguCode": "32020",
    "sidoName": "강원특별자치도",
    "sigunguName": "원주시"
  },
  "4201000": {
    "sidoCode": "51",
    "sigunguCode": "32030",
    "sidoName": "강원특별자치도",
    "sigunguName": "강릉시"
  },
  "4211000": {
    "sidoCode": "51",
    "sigunguCode": "32040",
    "sidoName": "강원특별자치도",
    "sigunguName": "동해시"
  },
  "4221000": {
    "sidoCode": "51",
    "sigunguCode": "32050",
    "sidoName": "강원특별자치도",
    "sigunguName": "태백시"
  },
  "4231000": {
    "sidoCode": "51",
    "sigunguCode": "32060",
    "sidoName": "강원특별자치도",
    "sigunguName": "속초시"
  },
  "4241000": {
    "sidoCode": "51",
    "sigunguCode": "32070",
    "sidoName": "강원특별자치도",
    "sigunguName": "삼척시"
  },
  "4251000": {
    "sidoCode": "51",
    "sigunguCode": "32310",
    "sidoName": "강원특별자치도",
    "sigunguName": "홍천군"
  },
  "4261000": {
    "sidoCode": "51",
    "sigunguCode": "32320",
    "sidoName": "강원특별자치도",
    "sigunguName": "횡성군"
  },
  "4271000": {
    "sidoCode": "51",
    "sigunguCode": "32330",
    "sidoName": "강원특별자치도",
    "sigunguName": "영월군"
  },
  "4281000": {
    "sidoCode": "51",
    "sigunguCode": "32340",
    "sidoName": "강원특별자치도",
    "sigunguName": "평창군"
  },
  "4291000": {
    "sidoCode": "51",
    "sigunguCode": "32350",
    "sidoName": "강원특별자치도",
    "sigunguName": "정선군"
  },
  "4301000": {
    "sidoCode": "51",
    "sigunguCode": "32360",
    "sidoName": "강원특별자치도",
    "sigunguName": "철원군"
  },
  "4311000": {
    "sidoCode": "51",
    "sigunguCode": "32370",
    "sidoName": "강원특별자치도",
    "sigunguName": "화천군"
  },
  "4321000": {
    "sidoCode": "51",
    "sigunguCode": "32380",
    "sidoName": "강원특별자치도",
    "sigunguName": "양구군"
  },
  "4331000": {
    "sidoCode": "51",
    "sigunguCode": "32390",
    "sidoName": "강원특별자치도",
    "sigunguName": "인제군"
  },
  "4341000": {
    "sidoCode": "51",
    "sigunguCode": "32400",
    "sidoName": "강원특별자치도",
    "sigunguName": "고성군"
  },
  "4351000": {
    "sidoCode": "51",
    "sigunguCode": "32410",
    "sidoName": "강원특별자치도",
    "sigunguName": "양양군"
  },
  "4390000": {
    "sidoCode": "43",
    "sigunguCode": "33020",
    "sidoName": "충청북도",
    "sigunguName": "충주시"
  },
  "4400000": {
    "sidoCode": "43",
    "sigunguCode": "33030",
    "sidoName": "충청북도",
    "sigunguName": "제천시"
  },
  "4420000": {
    "sidoCode": "43",
    "sigunguCode": "33320",
    "sidoName": "충청북도",
    "sigunguName": "보은군"
  },
  "4430000": {
    "sidoCode": "43",
    "sigunguCode": "33330",
    "sidoName": "충청북도",
    "sigunguName": "옥천군"
  },
  "4440000": {
    "sidoCode": "43",
    "sigunguCode": "33340",
    "sidoName": "충청북도",
    "sigunguName": "영동군"
  },
  "4450000": {
    "sidoCode": "43",
    "sigunguCode": "33350",
    "sidoName": "충청북도",
    "sigunguName": "진천군"
  },
  "4460000": {
    "sidoCode": "43",
    "sigunguCode": "33360",
    "sidoName": "충청북도",
    "sigunguName": "괴산군"
  },
  "4470000": {
    "sidoCode": "43",
    "sigunguCode": "33370",
    "sidoName": "충청북도",
    "sigunguName": "음성군"
  },
  "4480000": {
    "sidoCode": "43",
    "sigunguCode": "33380",
    "sidoName": "충청북도",
    "sigunguName": "단양군"
  },
  "4490000": {
    "sidoCode": "44",
    "sigunguCode": "34012",
    "sidoName": "충청남도",
    "sigunguName": "천안시 서북구"
  },
  "4500000": {
    "sidoCode": "44",
    "sigunguCode": "34020",
    "sidoName": "충청남도",
    "sigunguName": "공주시"
  },
  "4510000": {
    "sidoCode": "44",
    "sigunguCode": "34030",
    "sidoName": "충청남도",
    "sigunguName": "보령시"
  },
  "4520000": {
    "sidoCode": "44",
    "sigunguCode": "34040",
    "sidoName": "충청남도",
    "sigunguName": "아산시"
  },
  "4530000": {
    "sidoCode": "44",
    "sigunguCode": "34050",
    "sidoName": "충청남도",
    "sigunguName": "서산시"
  },
  "4540000": {
    "sidoCode": "44",
    "sigunguCode": "34060",
    "sidoName": "충청남도",
    "sigunguName": "논산시"
  },
  "4550000": {
    "sidoCode": "44",
    "sigunguCode": "34310",
    "sidoName": "충청남도",
    "sigunguName": "금산군"
  },
  "4570000": {
    "sidoCode": "44",
    "sigunguCode": "34330",
    "sidoName": "충청남도",
    "sigunguName": "부여군"
  },
  "4580000": {
    "sidoCode": "44",
    "sigunguCode": "34340",
    "sidoName": "충청남도",
    "sigunguName": "서천군"
  },
  "4590000": {
    "sidoCode": "44",
    "sigunguCode": "34350",
    "sidoName": "충청남도",
    "sigunguName": "청양군"
  },
  "4600000": {
    "sidoCode": "44",
    "sigunguCode": "34360",
    "sidoName": "충청남도",
    "sigunguName": "홍성군"
  },
  "4610000": {
    "sidoCode": "44",
    "sigunguCode": "34370",
    "sidoName": "충청남도",
    "sigunguName": "예산군"
  },
  "4620000": {
    "sidoCode": "44",
    "sigunguCode": "34380",
    "sidoName": "충청남도",
    "sigunguName": "태안군"
  },
  "4641000": {
    "sidoCode": "52",
    "sigunguCode": "35012",
    "sidoName": "전북특별자치도",
    "sigunguName": "전주시 덕진구"
  },
  "4671000": {
    "sidoCode": "52",
    "sigunguCode": "35020",
    "sidoName": "전북특별자치도",
    "sigunguName": "군산시"
  },
  "4681000": {
    "sidoCode": "52",
    "sigunguCode": "35030",
    "sidoName": "전북특별자치도",
    "sigunguName": "익산시"
  },
  "4691000": {
    "sidoCode": "52",
    "sigunguCode": "35040",
    "sidoName": "전북특별자치도",
    "sigunguName": "정읍시"
  },
  "4701000": {
    "sidoCode": "52",
    "sigunguCode": "35050",
    "sidoName": "전북특별자치도",
    "sigunguName": "남원시"
  },
  "4711000": {
    "sidoCode": "52",
    "sigunguCode": "35060",
    "sidoName": "전북특별자치도",
    "sigunguName": "김제시"
  },
  "4721000": {
    "sidoCode": "52",
    "sigunguCode": "35310",
    "sidoName": "전북특별자치도",
    "sigunguName": "완주군"
  },
  "4731000": {
    "sidoCode": "52",
    "sigunguCode": "35320",
    "sidoName": "전북특별자치도",
    "sigunguName": "진안군"
  },
  "4741000": {
    "sidoCode": "52",
    "sigunguCode": "35330",
    "sidoName": "전북특별자치도",
    "sigunguName": "무주군"
  },
  "4751000": {
    "sidoCode": "52",
    "sigunguCode": "35340",
    "sidoName": "전북특별자치도",
    "sigunguName": "장수군"
  },
  "4761000": {
    "sidoCode": "52",
    "sigunguCode": "35350",
    "sidoName": "전북특별자치도",
    "sigunguName": "임실군"
  },
  "4771000": {
    "sidoCode": "52",
    "sigunguCode": "35360",
    "sidoName": "전북특별자치도",
    "sigunguName": "순창군"
  },
  "4781000": {
    "sidoCode": "52",
    "sigunguCode": "35370",
    "sidoName": "전북특별자치도",
    "sigunguName": "고창군"
  },
  "4791000": {
    "sidoCode": "52",
    "sigunguCode": "35380",
    "sidoName": "전북특별자치도",
    "sigunguName": "부안군"
  },
  "5020000": {
    "sidoCode": "47",
    "sigunguCode": "37011",
    "sidoName": "경상북도",
    "sigunguName": "포항시 남구"
  },
  "5050000": {
    "sidoCode": "47",
    "sigunguCode": "37020",
    "sidoName": "경상북도",
    "sigunguName": "경주시"
  },
  "5060000": {
    "sidoCode": "47",
    "sigunguCode": "37030",
    "sidoName": "경상북도",
    "sigunguName": "김천시"
  },
  "5070000": {
    "sidoCode": "47",
    "sigunguCode": "37040",
    "sidoName": "경상북도",
    "sigunguName": "안동시"
  },
  "5080000": {
    "sidoCode": "47",
    "sigunguCode": "37050",
    "sidoName": "경상북도",
    "sigunguName": "구미시"
  },
  "5090000": {
    "sidoCode": "47",
    "sigunguCode": "37060",
    "sidoName": "경상북도",
    "sigunguName": "영주시"
  },
  "5100000": {
    "sidoCode": "47",
    "sigunguCode": "37070",
    "sidoName": "경상북도",
    "sigunguName": "영천시"
  },
  "5110000": {
    "sidoCode": "47",
    "sigunguCode": "37080",
    "sidoName": "경상북도",
    "sigunguName": "상주시"
  },
  "5120000": {
    "sidoCode": "47",
    "sigunguCode": "37090",
    "sidoName": "경상북도",
    "sigunguName": "문경시"
  },
  "5130000": {
    "sidoCode": "47",
    "sigunguCode": "37100",
    "sidoName": "경상북도",
    "sigunguName": "경산시"
  },
  "5141000": {
    "sidoCode": "47",
    "sigunguCode": "37310",
    "sidoName": "경상북도",
    "sigunguName": "군위군"
  },
  "5150000": {
    "sidoCode": "47",
    "sigunguCode": "37320",
    "sidoName": "경상북도",
    "sigunguName": "의성군"
  },
  "5160000": {
    "sidoCode": "47",
    "sigunguCode": "37330",
    "sidoName": "경상북도",
    "sigunguName": "청송군"
  },
  "5170000": {
    "sidoCode": "47",
    "sigunguCode": "37340",
    "sidoName": "경상북도",
    "sigunguName": "영양군"
  },
  "5180000": {
    "sidoCode": "47",
    "sigunguCode": "37350",
    "sidoName": "경상북도",
    "sigunguName": "영덕군"
  },
  "5190000": {
    "sidoCode": "47",
    "sigunguCode": "37360",
    "sidoName": "경상북도",
    "sigunguName": "청도군"
  },
  "5200000": {
    "sidoCode": "47",
    "sigunguCode": "37370",
    "sidoName": "경상북도",
    "sigunguName": "고령군"
  },
  "5210000": {
    "sidoCode": "47",
    "sigunguCode": "37380",
    "sidoName": "경상북도",
    "sigunguName": "성주군"
  },
  "5220000": {
    "sidoCode": "47",
    "sigunguCode": "37390",
    "sidoName": "경상북도",
    "sigunguName": "칠곡군"
  },
  "5230000": {
    "sidoCode": "47",
    "sigunguCode": "37400",
    "sidoName": "경상북도",
    "sigunguName": "예천군"
  },
  "5240000": {
    "sidoCode": "47",
    "sigunguCode": "37410",
    "sidoName": "경상북도",
    "sigunguName": "봉화군"
  },
  "5250000": {
    "sidoCode": "47",
    "sigunguCode": "37420",
    "sidoName": "경상북도",
    "sigunguName": "울진군"
  },
  "5260000": {
    "sidoCode": "47",
    "sigunguCode": "37430",
    "sidoName": "경상북도",
    "sigunguName": "울릉군"
  },
  "5310000": {
    "sidoCode": "48",
    "sigunguCode": "38030",
    "sidoName": "경상남도",
    "sigunguName": "진주시"
  },
  "5330000": {
    "sidoCode": "48",
    "sigunguCode": "38050",
    "sidoName": "경상남도",
    "sigunguName": "통영시"
  },
  "5340000": {
    "sidoCode": "48",
    "sigunguCode": "38060",
    "sidoName": "경상남도",
    "sigunguName": "사천시"
  },
  "5350000": {
    "sidoCode": "48",
    "sigunguCode": "38070",
    "sidoName": "경상남도",
    "sigunguName": "김해시"
  },
  "5360000": {
    "sidoCode": "48",
    "sigunguCode": "38080",
    "sidoName": "경상남도",
    "sigunguName": "밀양시"
  },
  "5370000": {
    "sidoCode": "48",
    "sigunguCode": "38090",
    "sidoName": "경상남도",
    "sigunguName": "거제시"
  },
  "5380000": {
    "sidoCode": "48",
    "sigunguCode": "38100",
    "sidoName": "경상남도",
    "sigunguName": "양산시"
  },
  "5390000": {
    "sidoCode": "48",
    "sigunguCode": "38310",
    "sidoName": "경상남도",
    "sigunguName": "의령군"
  },
  "5400000": {
    "sidoCode": "48",
    "sigunguCode": "38320",
    "sidoName": "경상남도",
    "sigunguName": "함안군"
  },
  "5410000": {
    "sidoCode": "48",
    "sigunguCode": "38330",
    "sidoName": "경상남도",
    "sigunguName": "창녕군"
  },
  "5420000": {
    "sidoCode": "48",
    "sigunguCode": "38340",
    "sidoName": "경상남도",
    "sigunguName": "고성군"
  },
  "5430000": {
    "sidoCode": "48",
    "sigunguCode": "38350",
    "sidoName": "경상남도",
    "sigunguName": "남해군"
  },
  "5440000": {
    "sidoCode": "48",
    "sigunguCode": "38360",
    "sidoName": "경상남도",
    "sigunguName": "하동군"
  },
  "5460000": {
    "sidoCode": "48",
    "sigunguCode": "38380",
    "sidoName": "경상남도",
    "sigunguName": "함양군"
  },
  "5470000": {
    "sidoCode": "48",
    "sigunguCode": "38390",
    "sidoName": "경상남도",
    "sigunguName": "거창군"
  },
  "5480000": {
    "sidoCode": "48",
    "sigunguCode": "38400",
    "sidoName": "경상남도",
    "sigunguName": "합천군"
  },
  "5530000": {
    "sidoCode": "41",
    "sigunguCode": "31240",
    "sidoName": "경기도",
    "sigunguName": "화성시"
  },
  "5540000": {
    "sidoCode": "41",
    "sigunguCode": "31250",
    "sidoName": "경기도",
    "sigunguName": "광주시"
  },
  "5570000": {
    "sidoCode": "43",
    "sigunguCode": "33390",
    "sidoName": "충청북도",
    "sigunguName": "증평군"
  },
  "5580000": {
    "sidoCode": "44",
    "sigunguCode": "34070",
    "sidoName": "충청남도",
    "sigunguName": "계룡시"
  },
  "5590000": {
    "sidoCode": "41",
    "sigunguCode": "31260",
    "sidoName": "경기도",
    "sigunguName": "양주시"
  },
  "5600000": {
    "sidoCode": "41",
    "sigunguCode": "31270",
    "sidoName": "경기도",
    "sigunguName": "포천시"
  },
  "5670000": {
    "sidoCode": "48",
    "sigunguCode": "38115",
    "sidoName": "경상남도",
    "sigunguName": "창원시 진해구"
  },
  "5680000": {
    "sidoCode": "44",
    "sigunguCode": "34080",
    "sidoName": "충청남도",
    "sigunguName": "당진시"
  },
  "5690000": {
    "sidoCode": "36",
    "sigunguCode": "29010",
    "sidoName": "세종특별자치시",
    "sigunguName": "세종시"
  },
  "5700000": {
    "sidoCode": "41",
    "sigunguCode": "31280",
    "sidoName": "경기도",
    "sigunguName": "여주시"
  },
  "5710000": {
    "sidoCode": "43",
    "sigunguCode": "33042",
    "sidoName": "충청북도",
    "sigunguName": "청주시 서원구"
  },
  "5780000": {
    "sidoCode": "46",
    "sigunguCode": "36010",
    "sidoName": "전라남도",
    "sigunguName": "목포시"
  },
  "5785000": {
    "sidoCode": "46",
    "sigunguCode": "36020",
    "sidoName": "전라남도",
    "sigunguName": "여수시"
  },
  "5790000": {
    "sidoCode": "46",
    "sigunguCode": "36030",
    "sidoName": "전라남도",
    "sigunguName": "순천시"
  },
  "5795000": {
    "sidoCode": "46",
    "sigunguCode": "36040",
    "sidoName": "전라남도",
    "sigunguName": "나주시"
  },
  "5800000": {
    "sidoCode": "46",
    "sigunguCode": "36060",
    "sidoName": "전라남도",
    "sigunguName": "광양시"
  },
  "5805000": {
    "sidoCode": "29",
    "sigunguCode": "24010",
    "sidoName": "광주광역시",
    "sigunguName": "동구"
  },
  "5810000": {
    "sidoCode": "29",
    "sigunguCode": "24020",
    "sidoName": "광주광역시",
    "sigunguName": "서구"
  },
  "5815000": {
    "sidoCode": "29",
    "sigunguCode": "24030",
    "sidoName": "광주광역시",
    "sigunguName": "남구"
  },
  "5820000": {
    "sidoCode": "29",
    "sigunguCode": "24040",
    "sidoName": "광주광역시",
    "sigunguName": "북구"
  },
  "5825000": {
    "sidoCode": "29",
    "sigunguCode": "24050",
    "sidoName": "광주광역시",
    "sigunguName": "광산구"
  },
  "5830000": {
    "sidoCode": "46",
    "sigunguCode": "36310",
    "sidoName": "전라남도",
    "sigunguName": "담양군"
  },
  "5835000": {
    "sidoCode": "46",
    "sigunguCode": "36320",
    "sidoName": "전라남도",
    "sigunguName": "곡성군"
  },
  "5840000": {
    "sidoCode": "46",
    "sigunguCode": "36330",
    "sidoName": "전라남도",
    "sigunguName": "구례군"
  },
  "5845000": {
    "sidoCode": "46",
    "sigunguCode": "36350",
    "sidoName": "전라남도",
    "sigunguName": "고흥군"
  },
  "5850000": {
    "sidoCode": "46",
    "sigunguCode": "36360",
    "sidoName": "전라남도",
    "sigunguName": "보성군"
  },
  "5855000": {
    "sidoCode": "46",
    "sigunguCode": "36370",
    "sidoName": "전라남도",
    "sigunguName": "화순군"
  },
  "5860000": {
    "sidoCode": "46",
    "sigunguCode": "36380",
    "sidoName": "전라남도",
    "sigunguName": "장흥군"
  },
  "5865000": {
    "sidoCode": "46",
    "sigunguCode": "36390",
    "sidoName": "전라남도",
    "sigunguName": "강진군"
  },
  "5870000": {
    "sidoCode": "46",
    "sigunguCode": "36400",
    "sidoName": "전라남도",
    "sigunguName": "해남군"
  },
  "5875000": {
    "sidoCode": "46",
    "sigunguCode": "36410",
    "sidoName": "전라남도",
    "sigunguName": "영암군"
  },
  "5880000": {
    "sidoCode": "46",
    "sigunguCode": "36420",
    "sidoName": "전라남도",
    "sigunguName": "무안군"
  },
  "5885000": {
    "sidoCode": "46",
    "sigunguCode": "36430",
    "sidoName": "전라남도",
    "sigunguName": "함평군"
  },
  "5890000": {
    "sidoCode": "46",
    "sigunguCode": "36440",
    "sidoName": "전라남도",
    "sigunguName": "영광군"
  },
  "5895000": {
    "sidoCode": "46",
    "sigunguCode": "36450",
    "sidoName": "전라남도",
    "sigunguName": "장성군"
  },
  "5900000": {
    "sidoCode": "46",
    "sigunguCode": "36460",
    "sidoName": "전라남도",
    "sigunguName": "완도군"
  },
  "5905000": {
    "sidoCode": "46",
    "sigunguCode": "36470",
    "sidoName": "전라남도",
    "sigunguName": "진도군"
  },
  "5910000": {
    "sidoCode": "46",
    "sigunguCode": "36480",
    "sidoName": "전라남도",
    "sigunguName": "신안군"
  },
  "6510000": {
    "sidoCode": "50",
    "sigunguCode": "39010",
    "sidoName": "제주특별자치도",
    "sigunguName": "제주시"
  },
  "6520000": {
    "sidoCode": "50",
    "sigunguCode": "39020",
    "sidoName": "제주특별자치도",
    "sigunguName": "서귀포시"
  }
};

export interface IntersectingRegionsResult {
  readonly tooWide: boolean;
  readonly regions: readonly KoreaAdminRegion[];
  readonly sidoCodes: readonly string[];
  readonly sigunguCodes: readonly string[];
}

export function findIntersectingAdminRegions(
  bounds: MapBounds,
  edgeBufferDeg = 0.005
): IntersectingRegionsResult {
  const latSpan = Math.abs(bounds.north - bounds.south);
  const lngSpan = Math.abs(bounds.east - bounds.west);

  if (
    latSpan > MAX_CANDIDATE_VIEWPORT_LAT_SPAN ||
    lngSpan > MAX_CANDIDATE_VIEWPORT_LNG_SPAN
  ) {
    return {
      tooWide: true,
      regions: [],
      sidoCodes: [],
      sigunguCodes: [],
    };
  }

  const qSouth = bounds.south - edgeBufferDeg;
  const qNorth = bounds.north + edgeBufferDeg;
  const qWest = bounds.west - edgeBufferDeg;
  const qEast = bounds.east + edgeBufferDeg;

  const regions = KOREA_ADMIN_REGIONS.filter(
    (r) =>
      r.north >= qSouth &&
      r.south <= qNorth &&
      r.east >= qWest &&
      r.west <= qEast
  );

  const sidoSet = new Set<string>();
  const sigunguSet = new Set<string>();
  for (const r of regions) {
    sidoSet.add(r.sidoCode);
    sigunguSet.add(r.sigunguCode);
  }

  return {
    tooWide: false,
    regions,
    sidoCodes: Array.from(sidoSet),
    sigunguCodes: Array.from(sigunguSet),
  };
}

export function extractEupMyeonDongName(
  roadAddress: string | null | undefined,
  jibunAddress: string | null | undefined
): string | null {
  const jibun = (jibunAddress || "").trim();
  const road = (roadAddress || "").trim();

  const jibunMatch = jibun.match(/\s([가-힣0-9]+(?:읍|면|동|로\d*가|가))(?=\s|\(|$)/);
  if (jibunMatch) return jibunMatch[1];

  const parenMatch = road.match(/\(([가-힣0-9]+(?:읍|면|동|가))(?=[,)])/);
  if (parenMatch) return parenMatch[1];

  const roadTownMatch = road.match(/\s([가-힣0-9]+(?:읍|면))(?=\s|$)/);
  if (roadTownMatch) return roadTownMatch[1];

  return null;
}

const SIDO_ALIAS_PATTERNS: ReadonlyArray<{ code: string; name: string; re: RegExp }> = [
  { code: "11", name: "서울특별시", re: /^(?:서울특별시|서울시|서울)\b/ },
  { code: "26", name: "부산광역시", re: /^(?:부산광역시|부산시|부산)\b/ },
  { code: "27", name: "대구광역시", re: /^(?:대구광역시|대구시|대구)\b/ },
  { code: "28", name: "인천광역시", re: /^(?:인천광역시|인천시|인천)\b/ },
  { code: "29", name: "광주광역시", re: /^(?:광주광역시|광주시)\b/ },
  { code: "30", name: "대전광역시", re: /^(?:대전광역시|대전시|대전)\b/ },
  { code: "31", name: "울산광역시", re: /^(?:울산광역시|울산시|울산)\b/ },
  { code: "36", name: "세종특별자치시", re: /^(?:세종특별자치시|세종시|세종)\b/ },
  { code: "41", name: "경기도", re: /^(?:경기도|경기)\b/ },
  { code: "51", name: "강원특별자치도", re: /^(?:강원특별자치도|강원도|강원)\b/ },
  { code: "43", name: "충청북도", re: /^(?:충청북도|충북)\b/ },
  { code: "44", name: "충청남도", re: /^(?:충청남도|충남)\b/ },
  { code: "52", name: "전북특별자치도", re: /^(?:전북특별자치도|전라북도|전북)\b/ },
  { code: "46", name: "전라남도", re: /^(?:전라남도|전남)\b/ },
  { code: "47", name: "경상북도", re: /^(?:경상북도|경북)\b/ },
  { code: "48", name: "경상남도", re: /^(?:경상남도|경남)\b/ },
  { code: "50", name: "제주특별자치도", re: /^(?:제주특별자치도|제주도|제주)\b/ },
];

const SIGUNGU_ALIASES: Readonly<Record<string, { sidoCode: string; sigunguName: string }>> = {
  미추홀구: { sidoCode: "28", sigunguName: "남구" },
  영종구: { sidoCode: "28", sigunguName: "중구" },
  제물포구: { sidoCode: "28", sigunguName: "중구" },
  서해구: { sidoCode: "28", sigunguName: "서구" },
  검단구: { sidoCode: "28", sigunguName: "서구" },
};

/**
 * Resolves exact administrative region (sidoCode, sigunguCode) from the record's own address first
 * (so multi-gu cities like 수원시 팔달구 / 영통구 map to exact gu-level codes), falling back to
 * 개방자치단체코드 (ORG_CODE_TO_REGION) when address omits province/district.
 */
export function resolveAdminRegionForRecord(params: {
  adminOrgCode?: string | null;
  roadAddress?: string | null;
  jibunAddress?: string | null;
}): OrgRegionInfo | null {
  const code = (params.adminOrgCode || "").trim();
  const orgFallback = code && ORG_CODE_TO_REGION[code] ? ORG_CODE_TO_REGION[code] : null;
  const rawAddr = `${params.roadAddress || ""} ${params.jibunAddress || ""}`.replace(/\s+/g, " ").trim();

  // Handle 전남광주통합특별시 (2026 administrative naming in raw CSV)
  let targetSidoCode: string | null = null;
  if (rawAddr.includes("전남광주통합특별시") && orgFallback) {
    targetSidoCode = orgFallback.sidoCode;
  } else {
    for (const s of SIDO_ALIAS_PATTERNS) {
      if (s.re.test(rawAddr)) {
        targetSidoCode = s.code;
        break;
      }
    }
  }
  if (!targetSidoCode && orgFallback) {
    targetSidoCode = orgFallback.sidoCode;
  }

  // Extract city+gu (e.g. 수원시 팔달구) or single sigungu token from address
  if (targetSidoCode) {
    const cityGuMatch = rawAddr.match(/([가-힣]+시)\s+([가-힣]+구)/);
    if (cityGuMatch && !/특별시|광역시|특별자치시/.test(cityGuMatch[1])) {
      const compactCityGu = `${cityGuMatch[1]}${cityGuMatch[2]}`;
      const exact = KOREA_ADMIN_REGIONS.find(
        (r) =>
          r.sidoCode === targetSidoCode &&
          r.sigunguName.replace(/\s+/g, "") === compactCityGu
      );
      if (exact) {
        return {
          sidoCode: exact.sidoCode,
          sigunguCode: exact.sigunguCode,
          sidoName: exact.sidoName,
          sigunguName: exact.sigunguName,
        };
      }
    }

    // Match single gu/si/gun inside the target sido
    const candidates = KOREA_ADMIN_REGIONS.filter((r) => r.sidoCode === targetSidoCode);
    for (const alias of Object.keys(SIGUNGU_ALIASES)) {
      if (rawAddr.includes(alias) && SIGUNGU_ALIASES[alias].sidoCode === targetSidoCode) {
        const aliased = candidates.find(
          (r) => r.sigunguName === SIGUNGU_ALIASES[alias].sigunguName
        );
        if (aliased) {
          return {
            sidoCode: aliased.sidoCode,
            sigunguCode: aliased.sigunguCode,
            sidoName: aliased.sidoName,
            sigunguName: alias,
          };
        }
      }
    }

    const tokenMatch = rawAddr.match(/\s([가-힣]+(?:시|군|구))(?:\s|$)/);
    if (tokenMatch) {
      const tok = tokenMatch[1];
      const exact = candidates.find((r) => r.sigunguName === tok);
      if (exact) {
        return {
          sidoCode: exact.sidoCode,
          sigunguCode: exact.sigunguCode,
          sidoName: exact.sidoName,
          sigunguName: exact.sigunguName,
        };
      }
    }

    // Check substring match for multi-gu cities or space-missing addresses
    for (const r of candidates) {
      const compactName = r.sigunguName.replace(/\s+/g, "");
      if (rawAddr.replace(/\s+/g, "").includes(compactName)) {
        return {
          sidoCode: r.sidoCode,
          sigunguCode: r.sigunguCode,
          sidoName: r.sidoName,
          sigunguName: r.sigunguName,
        };
      }
    }
  }

  return orgFallback;
}
