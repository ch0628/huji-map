# 03 — Data Model: authoritative dictionary

이 문서의 테이블/컬럼/상태값을 임의로 바꾸지 않는다. 외래키는 선행 테이블 마이그레이션에서 생성된 다음 추가 가능. `created_at`과 `updated_at` 트리거는 필요 시 자동 갱신한다. **모든 테이블은 RLS enabled, 직접 클라이언트 SQL 접근 기본 거부**.

SQL naming: lowercase snake_case. UUID defaults gen_random_uuid() for server-created IDs. 시간 timestamptz UTC 저장. 금액 원 단위 정수. 모든 사용자 input은 서버에서 zod로 검증.

## `profiles` — 인증 사용자 공개 최소 프로필

| 열 | SQL 형식 | 필수/제약 | 의미 |
|---|---|---|---|
| `id` | `uuid` | PK, auth.users(id) FK | Supabase auth 사용자 ID |
| `display_name` | `text` | NULL | 표시 이름 |
| `preferred_language` | `text` | NOT NULL DEFAULT ko | 언어 코드 |
| `account_status` | `text` | active/suspended/deleted | 접근상태, 서버만 수정 |
| `created_at` | `timestamptz` | NOT NULL DEFAULT now() | 생성 |
| `updated_at` | `timestamptz` | NOT NULL DEFAULT now() | 수정 |

## `user_roles` — 하나의 계정이 여러 역할 가질 수 있음

| 열 | SQL 형식 | 필수/제약 | 의미 |
|---|---|---|---|
| `user_id` | `uuid` | profiles.id FK, composite PK | 회원 |
| `role` | `text` | customer/merchant/admin, composite PK | 권한 |
| `granted_by` | `uuid` | NULL, profiles.id FK | 부여 주체 |
| `created_at` | `timestamptz` | DEFAULT now() | 권한 부여 시각 |

## `visitor_sessions` — 브라우저/방문 세션 (실제 사람 아님)

| 열 | SQL 형식 | 필수/제약 | 의미 |
|---|---|---|---|
| `id` | `uuid` | PK | 세션 ID |
| `browser_id` | `uuid` | NOT NULL, indexed | 브라우저 식별자 |
| `user_id` | `uuid` | NULL, profiles.id FK | 로그인 시 회원 |
| `started_at` | `timestamptz` | NOT NULL | 시작 |
| `last_seen_at` | `timestamptz` | NOT NULL | 마지막 활동 |
| `landing_path` | `text` | NOT NULL | 진입 경로 |
| `referrer` | `text` | NULL | 직전 페이지 |
| `utm_source` | `text` | NULL | 광고 매체 |
| `utm_medium` | `text` | NULL | 광고 유형 |
| `utm_campaign` | `text` | NULL | 캠페인 |
| `utm_content` | `text` | NULL | 소재 |
| `utm_term` | `text` | NULL | 키워드 |
| `device_type` | `text` | mobile/tablet/desktop/unknown | 기기 유형 |
| `language` | `text` | NULL | 브라우저 언어 |
| `is_test` | `boolean` | DEFAULT false | QA 세션 구분 |

## `consent_records` — 동의 이력. 개인정보/통계/마케팅 동의 구분

| 열 | SQL 형식 | 필수/제약 | 의미 |
|---|---|---|---|
| `id` | `uuid` | PK | 동의 기록 |
| `user_id` | `uuid` | NULL, profiles.id FK | 로그인 회원 |
| `browser_id` | `uuid` | NULL | 익명 브라우저 |
| `consent_type` | `text` | terms/privacy/analytics/marketing | 동의 종류 |
| `policy_version` | `text` | NOT NULL | 고지문 버전 |
| `accepted` | `boolean` | NOT NULL | 동의/철회 |
| `recorded_at` | `timestamptz` | DEFAULT now() | 기록 |
| `withdrawn_at` | `timestamptz` | NULL | 철회 |

## `business_leads` — 가게 접촉 대상 50곳과 H1 모수 관리

| 열 | SQL 형식 | 필수/제약 | 의미 |
|---|---|---|---|
| `id` | `uuid` | PK | 접촉 대상 |
| `business_name` | `text` | NOT NULL | 가게명 |
| `category` | `text` | NULL | 업종 |
| `road_address` | `text` | NULL | 주소 |
| `latitude` | `double precision` | NULL | 위도 |
| `longitude` | `double precision` | NULL | 경도 |
| `contact_phone` | `text` | NULL, private | 문의 연락처 |
| `lead_source` | `text` | NULL | 확보 경로 |
| `assigned_user_id` | `uuid` | NULL, profiles.id FK | 담당자 |
| `converted_business_id` | `uuid` | NULL, businesses.id FK | 실등록 가게 |
| `created_at` | `timestamptz` | DEFAULT now() | 생성 |
| `updated_at` | `timestamptz` | DEFAULT now() | 수정 |

## `lead_contact_attempts` — 연락 실적. 시도와 실등록은 별개

| 열 | SQL 형식 | 필수/제약 | 의미 |
|---|---|---|---|
| `id` | `uuid` | PK | 연락 시도 |
| `lead_id` | `uuid` | business_leads.id FK | 접촉 가게 |
| `contacted_by` | `uuid` | profiles.id FK | 연락한 팀원 |
| `contacted_at` | `timestamptz` | NOT NULL | 연락 시각 |
| `channel` | `text` | visit/phone/message/email | 채널 |
| `result` | `text` | no_answer/rejected/interested/agreed/follow_up | 결과 |
| `notes` | `text` | NULL, private | 메모 |
| `next_contact_at` | `timestamptz` | NULL | 후속 연락 |

## `businesses` — 제휴 가게 기본·승인 정보

| 열 | SQL 형식 | 필수/제약 | 의미 |
|---|---|---|---|
| `id` | `uuid` | PK | 가게 ID |
| `name` | `text` | NOT NULL | 가게명 |
| `category` | `text` | NOT NULL | 업종 |
| `description` | `text` | NULL | 설명 |
| `road_address` | `text` | NOT NULL | 도로명주소 |
| `jibun_address` | `text` | NULL | 지번 |
| `address_detail` | `text` | NULL | 상세위치 |
| `latitude` | `double precision` | NOT NULL | 위도 |
| `longitude` | `double precision` | NOT NULL | 경도 |
| `phone` | `text` | NULL | 가게 공개 전화번호 |
| `website_url` | `text` | NULL | 사이트 |
| `registration_status` | `text` | draft/pending/approved/rejected/suspended | 승인 상태 |
| `created_by` | `uuid` | profiles.id FK | 등록자 |
| `approved_by` | `uuid` | NULL, profiles.id FK | 승인 관리자 |
| `approved_at` | `timestamptz` | NULL | 승인 시각 |
| `rejection_reason` | `text` | NULL, private | 반려 사유 |
| `created_at` | `timestamptz` | DEFAULT now() | 생성 |
| `updated_at` | `timestamptz` | DEFAULT now() | 수정 |

## `business_members` — 가게 계정 소속/역할

| 열 | SQL 형식 | 필수/제약 | 의미 |
|---|---|---|---|
| `business_id` | `uuid` | businesses.id FK, composite PK | 가게 |
| `user_id` | `uuid` | profiles.id FK, composite PK | 회원 |
| `role` | `text` | owner/manager | 가게 내부 권한 |
| `membership_status` | `text` | active/revoked | 회원상태 |
| `joined_at` | `timestamptz` | DEFAULT now() | 가입 시각 |

## `business_verifications` — 가게 운영권한 인증 근거(관리자만 접근)

| 열 | SQL 형식 | 필수/제약 | 의미 |
|---|---|---|---|
| `id` | `uuid` | PK | 검증 ID |
| `business_id` | `uuid` | businesses.id FK | 가게 |
| `submitted_by` | `uuid` | profiles.id FK | 제출자 |
| `method` | `text` | in_person/phone/document | 확인방식 |
| `registration_number` | `text` | NULL, private | 사업자등록번호(동일점포 확인용) |
| `evidence_storage_path` | `text` | NULL, private | 증빙 사진/파일 |
| `status` | `text` | pending/approved/rejected | 확인상태 |
| `reviewed_by` | `uuid` | NULL, profiles.id FK | 관리자 |
| `reviewed_at` | `timestamptz` | NULL | 시각 |
| `review_notes` | `text` | NULL | 검증 메모 |
| `created_at` | `timestamptz` | DEFAULT now() | 제출 |

## `business_hours` — 가게 영업시간(화장실 개방시간과 별도)

| 열 | SQL 형식 | 필수/제약 | 의미 |
|---|---|---|---|
| `id` | `uuid` | PK | 영업시간 행 |
| `business_id` | `uuid` | businesses.id FK | 가게 |
| `weekday` | `smallint` | CHECK 0..6 | 요일 |
| `opens_at` | `time` | NULL | 개점 |
| `closes_at` | `time` | NULL | 폐점 |
| `is_closed` | `boolean` | NOT NULL DEFAULT false | 휴업 |
| `crosses_midnight` | `boolean` | DEFAULT false | 익일 걸침 |

## `public_data_sources` — 공공 데이터 출처/라이선스

| 열 | SQL 형식 | 필수/제약 | 의미 |
|---|---|---|---|
| `id` | `uuid` | PK | 출처 ID |
| `provider_name` | `text` | NOT NULL | 기관명 |
| `dataset_name` | `text` | NOT NULL | 자료명 |
| `source_url` | `text` | NOT NULL | 공식 URL |
| `api_endpoint` | `text` | NULL | API 주소 |
| `license_name` | `text` | NULL | 라이선스 |
| `license_url` | `text` | NULL | 라이선스 링크 |
| `attribution_text` | `text` | NULL | 출처 고지문 |
| `last_synced_at` | `timestamptz` | NULL | 최종 갱신 |
| `created_at` | `timestamptz` | DEFAULT now() | 등록 |

## `public_import_runs` — 수집 처리 이력

| 열 | SQL 형식 | 필수/제약 | 의미 |
|---|---|---|---|
| `id` | `uuid` | PK | 실행 ID |
| `source_id` | `uuid` | public_data_sources.id FK | 출처 |
| `started_at` | `timestamptz` | NOT NULL | 시작 |
| `finished_at` | `timestamptz` | NULL | 종료 |
| `status` | `text` | running/success/failed | 상태 |
| `fetched_count` | `integer` | DEFAULT 0 | 수집 |
| `inserted_count` | `integer` | DEFAULT 0 | 삽입 |
| `updated_count` | `integer` | DEFAULT 0 | 갱신 |
| `error_count` | `integer` | DEFAULT 0 | 오류 수 |
| `error_message` | `text` | NULL | 사유 |

## `restrooms` — 공공·제휴 화장실 공통 원천

| 열 | SQL 형식 | 필수/제약 | 의미 |
|---|---|---|---|
| `id` | `uuid` | PK | 화장실 |
| `business_id` | `uuid` | NULL, businesses.id FK; required partner | 제휴 가게 |
| `source_id` | `uuid` | NULL, public_data_sources.id FK; required public | 공공 출처 |
| `source_record_id` | `text` | NULL; unique(source_id,source_record_id) | 원천 식별자 |
| `type` | `text` | public/partner | 종류 |
| `name` | `text` | NOT NULL | 이름 |
| `description` | `text` | NULL | 소개 |
| `road_address` | `text` | NOT NULL | 주소 |
| `address_detail` | `text` | NULL | 상세 위치 |
| `latitude` | `double precision` | NOT NULL, -90..90 | 위도 |
| `longitude` | `double precision` | NOT NULL, -180..180 | 경도 |
| `floor` | `text` | NULL | 층 |
| `entrance_instructions` | `text` | NULL | 입구 설명 |
| `gender_type` | `text` | male/female/separate/unisex/unknown | 유형 |
| `wheelchair_accessible` | `boolean` | NULL=미확인 | 휠체어 |
| `baby_changing_available` | `boolean` | NULL=미확인 | 기저귀 |
| `sanitary_products_available` | `boolean` | NULL=미확인 | 생리대 |
| `access_method` | `text` | open/ask_staff/pin | 출입 방식 |
| `publication_status` | `text` | draft/pending/published/suspended/archived | 공개 상태 |
| `last_verified_at` | `timestamptz` | NULL | 실제 정보 확인일 |
| `created_by` | `uuid` | NULL, profiles.id FK | 등록자 |
| `approved_by` | `uuid` | NULL, profiles.id FK | 승인자 |
| `created_at` | `timestamptz` | DEFAULT now() | 생성 |
| `updated_at` | `timestamptz` | DEFAULT now() | 수정 |

## `restroom_hours` — 화장실 이용가능 시간. 하나의 요일 복수 시간구간 가능

| 열 | SQL 형식 | 필수/제약 | 의미 |
|---|---|---|---|
| `id` | `uuid` | PK | 시간 행 |
| `restroom_id` | `uuid` | restrooms.id FK | 화장실 |
| `weekday` | `smallint` | CHECK 0..6 | 요일 |
| `opens_at` | `time` | NULL | 열림 |
| `closes_at` | `time` | NULL | 닫힘 |
| `is_closed` | `boolean` | DEFAULT false | 휴무 |
| `crosses_midnight` | `boolean` | DEFAULT false | 익일 종료 |

## `restroom_hour_exceptions` — 특별 휴무/임시 운영

| 열 | SQL 형식 | 필수/제약 | 의미 |
|---|---|---|---|
| `id` | `uuid` | PK | 예외 |
| `restroom_id` | `uuid` | restrooms.id FK | 화장실 |
| `exception_date` | `date` | NOT NULL | 해당 날짜 |
| `is_closed` | `boolean` | DEFAULT false | 휴무 |
| `opens_at` | `time` | NULL | 변경 시작 |
| `closes_at` | `time` | NULL | 변경 종료 |
| `reason` | `text` | NULL | 이유 |
| `created_by` | `uuid` | profiles.id FK | 입력자 |
| `created_at` | `timestamptz` | DEFAULT now() | 기록 |

## `restroom_access_policies` — 버전 있는 이용조건. 과거 결제 가격 고정

| 열 | SQL 형식 | 필수/제약 | 의미 |
|---|---|---|---|
| `id` | `uuid` | PK | 정책 ID |
| `restroom_id` | `uuid` | restrooms.id FK | 화장실 |
| `version` | `integer` | >=1; unique(restroom_id,version) | 버전 |
| `access_mode` | `text` | free/test_deposit/real_deposit | 결제 방식 |
| `deposit_amount_krw` | `integer` | NULL or >=0 | 보증금 |
| `refund_eligible` | `boolean` | NOT NULL DEFAULT false | 환급대상 여부 |
| `receipt_window_hours` | `integer` | NULL or >0 | 제출기한 테스트값 |
| `min_purchase_krw` | `integer` | NULL or >=0 | 최소구매 임시값 |
| `is_active` | `boolean` | DEFAULT false; 1 active per restroom | 적용 여부 |
| `effective_from` | `timestamptz` | NOT NULL | 시작 |
| `created_by` | `uuid` | profiles.id FK | 생성자 |
| `created_at` | `timestamptz` | DEFAULT now() | 등록 |

## `restroom_photos` — 전시 가능한 검수 사진

| 열 | SQL 형식 | 필수/제약 | 의미 |
|---|---|---|---|
| `id` | `uuid` | PK | 사진 |
| `restroom_id` | `uuid` | restrooms.id FK | 화장실 |
| `storage_path` | `text` | NOT NULL | 파일 경로 |
| `photo_type` | `text` | exterior/entrance/interior/signage/other | 용도 |
| `is_primary` | `boolean` | DEFAULT false | 대표 |
| `moderation_status` | `text` | pending/approved/rejected | 승인 |
| `uploaded_by` | `uuid` | profiles.id FK | 제출자 |
| `created_at` | `timestamptz` | DEFAULT now() | 생성 |

## `restroom_lock_secrets` — 절대 공개조회 금지. AES-256-GCM 암호화

| 열 | SQL 형식 | 필수/제약 | 의미 |
|---|---|---|---|
| `id` | `uuid` | PK | 키 ID |
| `restroom_id` | `uuid` | restrooms.id FK | 화장실 |
| `ciphertext_b64` | `text` | NOT NULL | 암호문 |
| `iv_b64` | `text` | NOT NULL | 초기화벡터 |
| `auth_tag_b64` | `text` | NOT NULL | 무결성 태그 |
| `key_version` | `integer` | NOT NULL | 암호화키 버전 |
| `code_version` | `integer` | NOT NULL | PIN 버전 |
| `valid_from` | `timestamptz` | NOT NULL | 시작 |
| `valid_until` | `timestamptz` | NULL | 종료 |
| `status` | `text` | active/rotated/revoked | 상태 |
| `created_by` | `uuid` | profiles.id FK | 등록자 |
| `created_at` | `timestamptz` | DEFAULT now() | 등록 |

## `access_sessions` — 실제 접근 권한/출입 시도

| 열 | SQL 형식 | 필수/제약 | 의미 |
|---|---|---|---|
| `id` | `uuid` | PK | 이용권 ID |
| `user_id` | `uuid` | profiles.id FK | 손님 |
| `restroom_id` | `uuid` | restrooms.id FK | 대상 |
| `policy_id` | `uuid` | restroom_access_policies.id FK | 구매 당시 정책 |
| `status` | `text` | created/authorized/code_revealed/completed/failed/expired/canceled | 진행상태 |
| `access_method_snapshot` | `text` | open/ask_staff/pin | 구매 당시 유형 |
| `idempotency_key` | `text` | UNIQUE | 중복 발급 방지 |
| `authorized_at` | `timestamptz` | NULL | 승인 |
| `code_revealed_at` | `timestamptz` | NULL | PIN 표시 |
| `expires_at` | `timestamptz` | NOT NULL | 이용권 만료 |
| `created_at` | `timestamptz` | DEFAULT now() | 생성 |
| `updated_at` | `timestamptz` | DEFAULT now() | 수정 |

## `pin_reveal_audits` — PIN 값은 저장하지 않음

| 열 | SQL 형식 | 필수/제약 | 의미 |
|---|---|---|---|
| `id` | `uuid` | PK | 감사 ID |
| `access_session_id` | `uuid` | access_sessions.id FK | 이용권 |
| `user_id` | `uuid` | profiles.id FK | 요청자 |
| `code_version` | `integer` | NULL | 요청된 버전 |
| `result` | `text` | success/denied/error | 결과 |
| `reason` | `text` | NULL, PIN 제외 | 사유 |
| `created_at` | `timestamptz` | DEFAULT now() | 시각 |

## `visit_confirmations` — 이용 성공 주장·확인 구분

| 열 | SQL 형식 | 필수/제약 | 의미 |
|---|---|---|---|
| `id` | `uuid` | PK | 확인 ID |
| `access_session_id` | `uuid` | access_sessions.id FK | 이용권 |
| `usage_status` | `text` | success/failed/unknown | 주장 결과 |
| `verification_method` | `text` | user/merchant/operator | 확인 주체 |
| `verified_by` | `uuid` | NULL, profiles.id FK | 확인 사용자 |
| `arrival_confirmed_at` | `timestamptz` | NULL | 도착 신고 |
| `failure_reason` | `text` | NULL | 실패 사유 |
| `verified_at` | `timestamptz` | NULL | 확인 시각 |

## `payment_orders` — Toss 테스트 주문과 승인 결과

| 열 | SQL 형식 | 필수/제약 | 의미 |
|---|---|---|---|
| `id` | `uuid` | PK | 내부 주문 ID |
| `access_session_id` | `uuid` | access_sessions.id FK | 이용권 |
| `user_id` | `uuid` | profiles.id FK | 주문자 |
| `order_id` | `text` | UNIQUE | PG 주문번호 |
| `provider` | `text` | toss | PG |
| `payment_mode` | `text` | test ONLY | 모드 |
| `amount_krw` | `integer` | >0 | 당시 주문 금액 |
| `status` | `text` | created/pending/approved/failed/canceled | 주문상태 |
| `provider_payment_key` | `text` | NULL, UNIQUE, private | PG 결제키 |
| `idempotency_key` | `text` | UNIQUE | 중복 승인 방지 |
| `approved_at` | `timestamptz` | NULL | 승인 |
| `failure_code` | `text` | NULL | 오류코드 |
| `created_at` | `timestamptz` | DEFAULT now() | 생성 |
| `updated_at` | `timestamptz` | DEFAULT now() | 수정 |

## `payment_refunds` — 1회 전액환급 MVP. API 응답과 성공 분리

| 열 | SQL 형식 | 필수/제약 | 의미 |
|---|---|---|---|
| `id` | `uuid` | PK | 환급 ID |
| `payment_order_id` | `uuid` | payment_orders.id FK UNIQUE | 원결제 |
| `receipt_submission_id` | `uuid` | NULL, receipt_submissions.id FK | 승인 영수증 |
| `amount_krw` | `integer` | >0 | 환불금액 |
| `status` | `text` | requested/processing/succeeded/failed | 상태 |
| `idempotency_key` | `text` | UNIQUE | 중복취소 방지 |
| `requested_by` | `uuid` | profiles.id FK | 요청 관리자 |
| `provider_cancel_id` | `text` | NULL | 취소 거래 ID |
| `failure_reason` | `text` | NULL | 실패 |
| `requested_at` | `timestamptz` | DEFAULT now() | 요청 |
| `completed_at` | `timestamptz` | NULL | 완료 |

## `receipt_submissions` — 수동 영수증 심사, OCR 없음

| 열 | SQL 형식 | 필수/제약 | 의미 |
|---|---|---|---|
| `id` | `uuid` | PK | 제출 ID |
| `access_session_id` | `uuid` | access_sessions.id FK | 이용권 |
| `user_id` | `uuid` | profiles.id FK | 제출자 |
| `storage_path` | `text` | NOT NULL, private | 영수증 사진 |
| `mime_type` | `text` | image/jpeg/png/webp | 파일 형식 |
| `file_size_bytes` | `integer` | >0, app <= 10MB | 용량 |
| `original_filename` | `text` | NULL, sanitized | 원래 이름 |
| `submission_status` | `text` | submitted/review_required/approved/rejected/resubmission_requested | 검수 상태 |
| `store_name_confirmed` | `text` | NULL | 관리자 확인 가게명 |
| `purchase_at_confirmed` | `timestamptz` | NULL | 관리자 확인 구매시각 |
| `purchase_amount_krw` | `integer` | NULL | 관리자 확인 금액 |
| `receipt_reference` | `text` | NULL, private | 영수증 식별번호(없을 수 있음) |
| `reviewed_by` | `uuid` | NULL, profiles.id FK | 검수자 |
| `reviewed_at` | `timestamptz` | NULL | 검수 시각 |
| `review_reason` | `text` | NULL | 심사 사유 |
| `created_at` | `timestamptz` | DEFAULT now() | 제출 |

## `receipt_review_audits` — 심사 변경 이력: append-only

| 열 | SQL 형식 | 필수/제약 | 의미 |
|---|---|---|---|
| `id` | `uuid` | PK | 이력 ID |
| `submission_id` | `uuid` | receipt_submissions.id FK | 영수증 |
| `reviewer_id` | `uuid` | profiles.id FK | 심사자 |
| `decision` | `text` | approved/rejected/resubmission_requested | 판정 |
| `reason` | `text` | NOT NULL | 이유 |
| `created_at` | `timestamptz` | DEFAULT now() | 기록 |

## `event_logs` — 사용자 행동 관찰. 거래의 진실 소스 아님

| 열 | SQL 형식 | 필수/제약 | 의미 |
|---|---|---|---|
| `id` | `uuid` | PK | 이벤트 ID |
| `client_event_id` | `uuid` | UNIQUE | 중복 전송 배제 |
| `event_name` | `text` | NOT NULL | 정의된 이벤트명 |
| `event_version` | `integer` | DEFAULT 1 | 스키마 버전 |
| `browser_id` | `uuid` | NULL | 브라우저 |
| `session_id` | `uuid` | NULL, visitor_sessions.id FK | 방문세션 |
| `user_id` | `uuid` | NULL, profiles.id FK | 회원 |
| `business_id` | `uuid` | NULL, businesses.id FK | 가게 |
| `restroom_id` | `uuid` | NULL, restrooms.id FK | 화장실 |
| `access_session_id` | `uuid` | NULL, access_sessions.id FK | 이용권 |
| `experiment_key` | `text` | NULL | 실험 |
| `page_path` | `text` | NULL | 페이지 |
| `component_id` | `text` | NULL | UI 위치 |
| `properties` | `jsonb` | NOT NULL DEFAULT {} | PII/PIN/키 금지 |
| `source` | `text` | client/server | 발생위치 |
| `is_test` | `boolean` | DEFAULT false | 실험 제외 여부 |
| `occurred_at` | `timestamptz` | NOT NULL | 발생 시각 |
| `received_at` | `timestamptz` | DEFAULT now() | 서버 수신 |

## `audit_logs` — 중요 변경 관리자 감사(변조 방지)

| 열 | SQL 형식 | 필수/제약 | 의미 |
|---|---|---|---|
| `id` | `uuid` | PK | 감사 ID |
| `actor_user_id` | `uuid` | NULL, profiles.id FK | 실행자 |
| `action` | `text` | NOT NULL | 행위 |
| `entity_type` | `text` | NOT NULL | 대상 테이블 |
| `entity_id` | `uuid` | NOT NULL | 대상 ID |
| `before_data` | `jsonb` | NULL, 민감필드 마스킹 | 이전 값 |
| `after_data` | `jsonb` | NULL, 민감필드 마스킹 | 이후 값 |
| `reason` | `text` | NULL | 사유 |
| `created_at` | `timestamptz` | DEFAULT now() | 기록 |

## `feature_flags` — 미구현 기능 활성화 제한

| 열 | SQL 형식 | 필수/제약 | 의미 |
|---|---|---|---|
| `key` | `text` | PK | 플래그명 |
| `enabled` | `boolean` | DEFAULT false | 활성 |
| `config` | `jsonb` | DEFAULT {} | 테스트 설정 |
| `updated_by` | `uuid` | NULL, profiles.id FK | 관리자 |
| `updated_at` | `timestamptz` | DEFAULT now() | 갱신 |

## `experiments` — PMF 판정 버전/기간

| 열 | SQL 형식 | 필수/제약 | 의미 |
|---|---|---|---|
| `id` | `uuid` | PK | 실험 ID |
| `experiment_key` | `text` | UNIQUE | 식별자 |
| `name` | `text` | NOT NULL | 이름 |
| `rules_version` | `text` | NOT NULL | 판정 원문 버전 |
| `starts_at` | `timestamptz` | NOT NULL | 시작 |
| `ends_at` | `timestamptz` | NOT NULL | 종료 |
| `status` | `text` | draft/running/closed | 상태 |
| `notes` | `text` | NULL | 메모 |
| `created_at` | `timestamptz` | DEFAULT now() | 등록 |

## 핵심 참조/제약

1. `restrooms.type=partner`: business_id 필수, source_id NULL; `public`: source_id 필수, business_id NULL. 좌표/주소 실측값; 모르면 UNKNOWN/검수대기, 허위 데이터 금지.
2. `restroom_access_policies`: (restroom_id,version) UNIQUE, 화장실당 `is_active=true` 부분 인덱스 UNIQUE. 결제 생성 후 정책 변경 시 이용건은 `policy_id` 스냅샷 사용.
3. `restroom_lock_secrets`: 해당 화장실당 활성 비밀번호 한 개. 암호문·nonce·태그 절대 API 직렬화 금지.
4. `payment_orders`: `order_id`와 provider_payment_key UNIQUE; 성공 주문은 access_session당 최대 하나 (부분 UNIQUE). 이미 성공한 승인 재호출은 동일 결과 반환.
5. `payment_refunds`: payment_order_id UNIQUE (MVP는 1건 전액환급). 환급액은 원 결제 승인 금액과 같아야 한다.
6. `receipt_submissions`: 유효한 승인 영수증은 access_session당 최대 하나. 여러 번 제출 가능하지만 동일 파일/영수증 재사용 방지 확인.
7. `business_members`: (business_id,user_id) 복합 PK. `user_roles` (user_id,role) 복합 PK. admin 권한은 계정 생성만으로 부여하지 않는다.
8. `event_logs`: client_event_id UNIQUE. event 속성에 정확한 위도경도·PIN·영수증 원본·결제키·카드정보·이메일 저장 금지.
9. `business_leads`: 한 lead에서 연락 시도 여러 개. H1 분모는 연락된 서로 다른 lead, 분자는 연락한 사업자 중 검수 완료 가게의 별도 고유 수.
10. `restroom_hours`는 `business_hours`와 분리. `NULL` 부대시설은 확인되지 않았다는 뜻이며 false와 다르다.
11. `receipt_review_audits`, `audit_logs`, `pin_reveal_audits`, `test event logs`는 운영자의 일반 편집 UI에서 삭제/수정 금지.
12. 모든 중요한 상태 enum은 CHECK constraints로 검증, 의미 있는 인덱스: `restrooms(publication_status,type,lat,lng)`, `event_logs(experiment_key,received_at,event_name,browser_id)`, `access_sessions(user_id,created_at)`, `receipt_submissions(submission_status,created_at)`.

## 이번 MVP에서 생성하지 않을 테이블

가상 크레딧 지갑/원장, OCR 결과, 월 구독 청구, 실거래 정산. 향후 필요 시 새 migration을 만든다.

## 읽기/쓰기 권한 정책

비회원: 공개 승인 화장실 조회 API·이벤트 제출만. 손님: 자신의 결제·이용·영수증. 가게: 자신이 속한 가게/화장실 관리만. 관리자: 검수·승인·운영. service_role은 서버 단독으로 사용하고 route 단위에서 역할/소유권을 검증. `restroom_lock_secrets` 데이터는 도어락 관리/조회 전용 서버 모듈 외 사용 금지.

## 마이그레이션 의존성 (구현 순서 오류 방지)

- `lead_tracking`에서 생성하는 `business_leads.converted_business_id`는 `business_backend`의 `businesses` 생성 전이므로 처음에는 컬럼만 만들고, **`business_backend`에서 FK 추가**.
- `events_backend`에서 생성하는 `event_logs.access_session_id`는 `payment_schema`의 `access_sessions`가 없으므로 처음에는 UUID 열+인덱스만 추가, **`payment_schema`에서 FK 추가**.
- `payment_schema`에서 생성하는 `payment_refunds.receipt_submission_id`는 `receipt_backend`의 `receipt_submissions`가 없으므로 처음에는 UUID 열만 추가, **`receipt_backend`에서 FK 추가**.
- `pin_reveal`에서 `visit_confirmations` 도메인 테이블도 함께 생성하되, 실제 확인 UI/API는 `pin_ui`에서 구현.
- `auth_schema`에서 `feature_flags`도 생성. 필드 정의는 위 문서에 따른다.
- 상호참조가 있는 테이블은 모두 생성한 뒤 `ALTER TABLE ADD CONSTRAINT`로 추가. 기존 데이터 점검 후 마이그레이션 실행.
