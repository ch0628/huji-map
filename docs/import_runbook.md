# 공공 화장실 데이터 수집 및 임포트 런북 (Import Runbook)

## 1. 개요 및 공공데이터 출처 정보

- **기관명**: 행정안전부 및 지방자치단체 (경기도 수원시)
- **데이터셋명**: 전국공중화장실표준데이터 (또는 경기도 수원시 공중화장실 현황)
- **공공데이터포털 등록번호**: `15012892`
- **공식 다운로드/조회 URL**:
  - 표준데이터: [https://www.data.go.kr/data/15012892/standard.do](https://www.data.go.kr/data/15012892/standard.do)
  - 파일데이터: [https://www.data.go.kr/data/15012892/fileData.do](https://www.data.go.kr/data/15012892/fileData.do)
- **이용 허락 조건**: **공공누리 제1유형 (출처표시)**
  - 법적 근거: 공공데이터의 제공 및 이용 활성화에 관한 법률 제3조(공공데이터의 제공 원칙) 및 저작권법 제24조의2(공공저작물의 자유이용)
  - 상업적/비상업적 자유 이용 가능, 2차적 저작물 작성 및 변형 허용 (출처표시 필수)
- **출처 고지문**: `출처: 공공데이터포털(data.go.kr) / 행정안전부 및 경기도 수원시`

---

## 2. 지역 필터링 및 데이터 정규화 규약

### 2.1 전국 표준데이터 내 수원시 레코드 격리
- `전국공중화장실표준데이터(15012892)`는 전국 지자체 데이터가 망라되어 있으므로, HujiMap 초기 서비스 타깃(수원시) 외 타 지자체 데이터의 무단 적재를 방지하기 위해 기본적으로 **`cityFilter = "수원"`** 필터가 적용됩니다.
- `소재지도로명주소`, `소재지지번주소`, `관리기관명`에 '수원'이 포함되지 않은 레코드는 자동으로 건너뜁니다(`skipped_count`).

### 2.2 원천 식별자(`source_record_id`) 생성 규칙
1. **명시적 관리번호**: 원본의 `화장실관리번호` 또는 `연번`이 존재하는 경우 이를 그대로 사용합니다 (예: `SUWON-PB-001`).
2. **해시 기반 식별자 (Fallback)**: 관리번호가 누락된 경우, 공백과 특수문자를 정규화한 `[정규화이름]::[정규화주소]`의 SHA-256 해시 앞 16자리를 취해 `SUWON-GEN-[hash]` 형태로 생성합니다. 단순 띄어쓰기 오타 등으로 인한 중복 생성을 억제합니다.

### 2.3 필드 매핑 및 좌표 격리

| 원본 공공데이터 칼럼 | HujiMap 스키마 매핑 | 처리 규약 및 안전 제약 |
|---|---|---|
| `화장실관리번호` / `연번` | `restrooms.source_record_id` | 미제공 시 정규화 해시 `SUWON-GEN-[hash]` 자동 생성 |
| `화장실명` | `restrooms.name` | 필수 필드. 누락 시 오류 처리 및 건너뜀 |
| `소재지도로명주소` | `restrooms.road_address` | 도로명 우선, 없으면 지번주소 폴백. 둘 다 없으면 오류 |
| `소재지지번주소` | `restrooms.address_detail` | 지번주소가 도로명과 다를 경우 `(지번) ...` 형태로 보존 |
| `WGS84위도`, `WGS84경도` | `restrooms.latitude`, `longitude` | 부동소수점 검증 및 대한민국 영역(30~45°N, 120~135°E) 검증 |
| (좌표 유효 여부) | `restrooms.publication_status` | **좌표 유효 시**: `published`<br>**좌표 미확인/오류 시**: `draft` (지도 목록 격리) |
| `남녀공용화장실여부` | `restrooms.gender_type` | `Y` → `unisex`, `N` → `separate`, 기타 → `unknown` |
| `남/여 장애인용 대/소변기수` | `restrooms.wheelchair_accessible` | 합산 1 이상 시 `true`, 0일 시 `false`, 미파싱 시 `null` |
| `기저귀교환대유무` | `restrooms.baby_changing_available` | `Y` → `true`, `N` → `false`, 기타 → `null` |
| (화장실 구분) | `restrooms.access_method` | 공공화장실은 무료 `open` 고정 (PIN 절대 금지) |
| `데이터기준일자` | `restrooms.last_verified_at` | 날짜 ISO 파싱. 미래 시각 방지(SQLSTATE 22007) 적용 |
| `개방시간`, `관리기관`, `전화번호` | `restrooms.description` | 개방시간 및 관리부서 요약 텍스트 구성 |

---

## 3. 관리자 상태 보존 및 중복 방지 (Idempotency)

1. **관리자 비공개 상태 보존 (Admin Status Protection)**:
   - 관리자가 시설 폐쇄, 철거, 안전 점검 등의 사유로 기존 화장실의 `publication_status`를 `archived` 또는 `suspended`로 변경한 경우,
   - **공공데이터 재수집 시에도 해당 비공개 상태를 보존**하며 강제로 `published`로 되살리지 않습니다 (`preserveAdminStatus: true`).
2. **DB 레벨 고유 제약조건**:
   - `idx_restrooms_source_unique (source_id, source_record_id) WHERE source_id IS NOT NULL`
3. **재실행 멱등성**:
   - 동일 파일을 2회 이상 실행해도 신규 INSERT는 0건이며, 변경 사항이 없는 레코드는 `skipped_count`로 안전하게 통과됩니다.
   - 정보가 변경된 경우에만 안전하게 UPDATE 됩니다.

---

## 4. 수집 실행 명령어 및 2중 안전장치

### 4.1 사전 점검 (Dry-Run: DB 쓰기 없이 파싱/검증만 수행)
DB 연결 없이 로컬에서 파싱, 필터링, 좌표 유효성을 사전 분석합니다.
```bash
npx tsx scripts/import-public-restrooms.ts --file tests/fixtures/public/suwon_public_restrooms_sample.csv --dry-run
```

### 4.2 실제 DB 반영 (Live: 관리자 권한 및 2중 확인 필수)
> **안전 가드**: `--live` 모드 진입 시 대상 DB, 출처, 파싱 통계가 먼저 화면에 출력되며, `--confirm` 플래그가 없으면 실제 쓰기를 수행하지 않고 중단됩니다.
```bash
# 실제 DB 반영 시 --confirm 플래그 필수
npx tsx scripts/import-public-restrooms.ts --file <실제_CSV_파일경로> --live --confirm
```

---

## 5. 수집 이력 추적 및 장애 복구

- 모든 수집 시도는 `public_import_runs` 테이블에 고유 `id`, `started_at`, `finished_at`, `status` (`running`/`success`/`failed`), `fetched_count`, `inserted_count`, `updated_count`, `error_count`, `error_message`로 기록됩니다.
- 수집 성공 시 `public_data_sources.last_synced_at`이 갱신됩니다.
- 개별 레코드 오류(필수값 누락 등)가 발생해도 유효한 레코드는 정상 처리되며, 전체 수집 작업이 실패하더라도 기존 적재된 화장실 데이터는 절대 삭제되지 않습니다.
