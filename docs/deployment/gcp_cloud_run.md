# HUJIMAP — Google Cloud Run 배포 가이드 (스테이징 MVP)

이 문서는 **HUJIMAP**을 Google Cloud Run(`asia-northeast3`, 서울)에 최초 배포하고, GitHub `main` 브랜치 push 시 Cloud Build로 자동 배포하는 절차를 정리합니다.

> [!IMPORTANT]
> - 이 문서의 `<PROJECT_ID>`, `<PROJECT_NUMBER>`, `<REGION>` 등은 실제 GCP 프로젝트 값으로 치환해야 합니다. 프로젝트 ID를 임의로 추정하지 마세요.
> - 결제 모드는 `disabled` 또는 `test`만 허용됩니다. Toss Payments 실거래 키(`live_`)는 절대 등록하지 마세요.
> - 서버 전용 비밀키(`SUPABASE_SECRET_KEY`, `TOSS_TEST_SECRET_KEY`, `PIN_ENCRYPTION_KEY_BASE64`)는 절대 Git, Dockerfile, Cloud Build 로그에 노출하지 말고 **Secret Manager**에만 저장하세요.

---

## 목표 아키텍처 및 배포 스펙

- **GitHub 저장소**: `https://github.com/ch0628/huji-map.git` (`main` 브랜치)
- **GCP 프로젝트 이름**: `HUJIMAP-MVP` (실제 프로젝트 ID는 아래 1단계에서 확인)
- **리전**: `asia-northeast3` (서울)
- **Cloud Run 스펙**: 1 vCPU, 1 GiB 메모리, 최소 인스턴스 0, 최대 인스턴스 2, 요청 기반 과금(`--cpu-throttling`), 포트 `8080`
- **데이터베이스**: 기존 원격 Supabase 사용

---

## 1. GCP 프로젝트 ID 확인 방법

1. [Google Cloud Console](https://console.cloud.google.com/)에 로그인합니다.
2. 상단 프로젝트 선택 드롭다운에서 **HUJIMAP-MVP**를 선택합니다.
3. 대시보드 **프로젝트 정보(Project info)** 카드에서 **프로젝트 ID(`PROJECT_ID`)**와 **프로젝트 번호(`PROJECT_NUMBER`)**를 확인합니다.
4. 로컬 터미널(`gcloud` CLI 사용 시)에서 다음으로 확인할 수 있습니다.

```bash
gcloud projects list --filter="name:HUJIMAP-MVP" --format="table(projectId,projectNumber,name)"
gcloud config set project <PROJECT_ID>
```

5. 필요한 GCP API를 활성화합니다.
   - Cloud Console **API 및 서비스 → 라이브러리** 또는 아래 CLI 실행:

```bash
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  iam.googleapis.com
```

---

## 2. Artifact Registry 저장소 생성

Cloud Build가 빌드한 Docker 이미지를 저장할 Docker 저장소를 `asia-northeast3`에 생성합니다.

- **콘솔 경로**: **Artifact Registry → 저장소 → 저장소 만들기**
  - 이름: `hujimap`
  - 형식: `Docker`
  - 모드: `표준(Standard)`
  - 위치 유형: `리전` → `asia-northeast3 (서울)`
  - (선택) 정리 정책: 오래된 이미지 태그 보관 개수 제한 설정 권장(예: 최근 10개 유지)

```bash
gcloud artifacts repositories create hujimap \
  --repository-format=docker \
  --location=asia-northeast3 \
  --description="HUJIMAP container images"
```

---

## 3. Cloud Build 서비스 계정 권한 설정 (최소 권한)

2세대 GitHub 트리거 또는 사용자 지정 Cloud Build 서비스 계정을 사용할 때 **최소 권한 원칙**에 따라 전용 서비스 계정을 사용합니다. (기본 Compute Engine 서비스 계정 사용 시에도 필요한 최소 역할만 유지하세요.)

1. **IAM 및 관리자 → 서비스 계정 → 서비스 계정 만들기**
   - 이름 예: `hujimap-cloudbuild` (`hujimap-cloudbuild@<PROJECT_ID>.iam.gserviceaccount.com`)
2. 아래 최소 역할을 부여합니다.

| 역할(Role) | 목적 |
|---|---|
| `roles/artifactregistry.writer` | 빌드한 Docker 이미지를 Artifact Registry(`hujimap` 저장소)에 Push |
| `roles/run.developer` | Cloud Run 서비스(`hujimap-staging`) 새 Revision 배포 및 트래픽 업데이트 |
| `roles/iam.serviceAccountUser` | Cloud Run 서비스가 **실행 서비스 계정(`hujimap-runner`)**을 사용하도록 위임 (**해당 실행 서비스 계정 리소스에만 한정 부여 권장**) |
| `roles/logging.logWriter` | `CLOUD_LOGGING_ONLY` 모드에서 Cloud Build 빌드 로그 기록 |

```bash
# Cloud Build 서비스 계정 생성
gcloud iam service-accounts create hujimap-cloudbuild \
  --display-name="HUJIMAP Cloud Build Deployer"

# 1) Artifact Registry 쓰기 권한 (저장소 단위 또는 프로젝트 단위)
gcloud artifacts repositories add-iam-policy-binding hujimap \
  --location=asia-northeast3 \
  --member="serviceAccount:hujimap-cloudbuild@<PROJECT_ID>.iam.gserviceaccount.com" \
  --role="roles/artifactregistry.writer"

# 2) Cloud Run 배포 권한
gcloud projects add-iam-policy-binding <PROJECT_ID> \
  --member="serviceAccount:hujimap-cloudbuild@<PROJECT_ID>.iam.gserviceaccount.com" \
  --role="roles/run.developer"

# 3) Cloud Build 로그 기록 권한
gcloud projects add-iam-policy-binding <PROJECT_ID> \
  --member="serviceAccount:hujimap-cloudbuild@<PROJECT_ID>.iam.gserviceaccount.com" \
  --role="roles/logging.logWriter"
```

> [!NOTE]
> `roles/iam.serviceAccountUser`는 프로젝트 전체가 아니라 **4단계에서 생성한 Cloud Run 실행 서비스 계정**에 대해서만 부여하는 것이 최소 권한 원칙에 맞습니다.

---

## 4. Cloud Run 실행 서비스 계정 설정 (최소 권한)

컨테이너가 런타임에 동작할 때 사용하는 전용 서비스 계정을 만듭니다. 빌드 계정이 아니라 **런타임 전용**이며, Secret Manager 읽기 권한만 가집니다.

1. **IAM 및 관리자 → 서비스 계정 → 서비스 계정 만들기**
   - 이름 예: `hujimap-runner` (`hujimap-runner@<PROJECT_ID>.iam.gserviceaccount.com`)
2. 이 서비스 계정 자체에는 프로젝트 편집자(`Editor`) 권한을 주지 않습니다.
3. **5단계 Secret Manager 비밀키 생성 후**, 각 비밀키에 대해서만 `roles/secretmanager.secretAccessor` 역할을 부여합니다.
4. Cloud Build 서비스 계정(`hujimap-cloudbuild`)이 `hujimap-runner`를 사용할 수 있도록 위임 권한을 부여합니다.

```bash
gcloud iam service-accounts create hujimap-runner \
  --display-name="HUJIMAP Cloud Run Runtime"

gcloud iam service-accounts add-iam-policy-binding \
  hujimap-runner@<PROJECT_ID>.iam.gserviceaccount.com \
  --member="serviceAccount:hujimap-cloudbuild@<PROJECT_ID>.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountUser"
```

---

## 5. Secret Manager 비밀키 등록

서버 전용 비밀키 3종을 **보안 비밀 관리자(Secret Manager)**에 등록합니다. 콘솔 로그나 파일에 비밀값이 남지 않도록 주의하세요.

- **콘솔 경로**: **보안 → Secret Manager → 보안 비밀 만들기**
- 등록할 비밀 이름(기본값은 `cloudbuild.yaml` 치환 변수와 일치):

| Secret 이름 | 연결될 런타임 환경변수 | 값 설명 |
|---|---|---|
| `hujimap-supabase-secret-key` | `SUPABASE_SECRET_KEY` | 원격 Supabase Secret Key (또는 Service Role Key) |
| `hujimap-toss-test-secret-key` | `TOSS_TEST_SECRET_KEY` | Toss Payments **테스트** 시크릿 키 (`test_`로 시작; 결제 비활성 시 빈 값 또는 더미 대신 실제 테스트 키 준비 후 등록) |
| `hujimap-pin-encryption-key` | `PIN_ENCRYPTION_KEY_BASE64` | 32바이트 AES-256-GCM Base64 키 (로컬에서 생성한 키를 Secret Manager에만 입력) |

> [!CAUTION]
> - `TOSS_TEST_SECRET_KEY`에 `live_` 키를 절대 등록하지 마세요.
> - `PIN_ENCRYPTION_KEY_BASE64`를 나중에 변경하면 기존 암호화된 도어락 PIN을 복호화할 수 없으므로 안전하게 백업·관리하세요.
> - 아직 Toss 테스트 키가 없다면 `PAYMENT_MODE=disabled`로 유지하고, 결제 기능이 필요한 시점에 테스트 키를 등록하세요. Secret Manager는 빈 문자열(`""`)을 허용하지 않으므로, 미사용 시 더미가 아닌 실제 키 준비 전까지 해당 시크릿이 없다면 임시로 `disabled` 상태용 placeholder 대신 Cloud Run 배포 옵션에서 해당 시크릿 바인딩을 제외하거나 테스트 키를 발급받아 등록해야 합니다. (실제 `cloudbuild.yaml` 기본값은 3개 Secret이 모두 Secret Manager에 존재할 것을 전제로 합니다.)

각 Secret에 대해 Cloud Run 실행 서비스 계정(`hujimap-runner`)에만 접근 권한을 부여합니다.

```bash
for SECRET_NAME in \
  hujimap-supabase-secret-key \
  hujimap-toss-test-secret-key \
  hujimap-pin-encryption-key; do
  gcloud secrets add-iam-policy-binding "${SECRET_NAME}" \
    --member="serviceAccount:hujimap-runner@<PROJECT_ID>.iam.gserviceaccount.com" \
    --role="roles/secretmanager.secretAccessor"
done
```

---

## 6. Cloud Run 최초 배포 방법

최초 배포 전에는 Cloud Run 서비스 URL(`https://<service>-<hash>-du.a.run.app`)이 아직 확정되지 않습니다.

- `depositPayment`의 Toss 리다이렉트(`window.location.origin`)는 브라우저 주소를 동적으로 사용하므로 최초 URL을 빌드에 넣지 않아도 동작합니다.
- `signup` 이메일 인증 리다이렉트는 서버 런타임 환경변수 `APP_URL`이 있으면 우선 사용하고, 최초 배포 직후 `APP_URL`이 비어 있더라도 Cloud Run 환경(`K_SERVICE`)에서 검증된 `*.a.run.app` HTTPS 주소를 안전하게 사용합니다.
- 최초 배포 후 URL이 확정되면 9단계에 따라 `APP_URL`을 설정하는 것을 권장합니다.

### 외부 공개 접근 허용 여부 결정 (중요)

- **비회원 지도 탐색 허용(일반 스테이징 QA)**: `--allow-unauthenticated` (모바일 기기/외부 테스터 브라우저 접속 가능)
- **내부 팀원만 IAM 인증으로 접근 제한**: `--no-allow-unauthenticated`

> `cloudbuild.yaml`에는 임의로 `--allow-unauthenticated`를 강제하지 않았습니다. 최초 서비스 생성 시 사용자가 의도에 맞게 선택하세요. (한 번 설정된 IAM 정책은 이후 `cloudbuild.yaml` 재배포 시 유지됩니다.)

### 최초 배포 절차 (Cloud Build 수동 실행 또는 콘솔)

1. Cloud Build로 이미지 빌드 및 최초 배포 실행(예시):

```bash
gcloud builds submit \
  --config=cloudbuild.yaml \
  --substitutions=\
COMMIT_SHA=initial,\
_REGION=asia-northeast3,\
_AR_REPOSITORY=hujimap,\
_SERVICE_NAME=hujimap-staging,\
_RUN_SERVICE_ACCOUNT=hujimap-runner@<PROJECT_ID>.iam.gserviceaccount.com,\
_PAYMENT_MODE=disabled,\
_NEXT_PUBLIC_SUPABASE_URL=https://<SUPABASE_PROJECT_REF>.supabase.co,\
_NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<SUPABASE_PUBLISHABLE_KEY>,\
_NEXT_PUBLIC_KAKAO_MAP_JS_KEY=<KAKAO_JS_KEY>,\
_NEXT_PUBLIC_TOSS_TEST_CLIENT_KEY=<TOSS_TEST_CLIENT_KEY>,\
_NEXT_PUBLIC_ANALYTICS_ENABLED=false
```

2. 외부 비회원 접속을 허용하려면(사용자 확인 후 결정):

```bash
gcloud run services add-iam-policy-binding hujimap-staging \
  --region=asia-northeast3 \
  --member="allUsers" \
  --role="roles/run.invoker"
```

---

## 7. GitHub 저장소 연결

1. Cloud Console에서 **Cloud Build → 저장소 (2세대)**로 이동합니다.
2. 리전을 **`asia-northeast3`**으로 선택하고 **호스트 연결 만들기 → GitHub**를 클릭합니다.
3. GitHub 계정 인증 및 **Google Cloud Build** 앱 권한 부여 시 `ch0628/huji-map` 저장소에 대한 접근을 허용합니다.
4. 연결 생성 후 **저장소 연결**에서 `https://github.com/ch0628/huji-map.git` 저장소를 등록합니다.

---

## 8. `main` 브랜치 자동 배포 트리거 설정

1. **Cloud Build → 트리거 → 트리거 만들기**로 이동합니다.
2. 기본 설정:
   - 이름: `hujimap-main-deploy`
   - 리전: `asia-northeast3`
   - 이벤트: **브랜치에 푸시**
   - 소스 저장소: 7단계에서 연결한 `ch0628/huji-map`
   - 브랜치 정규식: `^main$`
3. 구성:
   - 유형: **Cloud Build 구성 파일(YAML 또는 JSON)**
   - 위치: **저장소** → `cloudbuild.yaml`
   - 서비스 계정: 3단계에서 만든 `hujimap-cloudbuild@<PROJECT_ID>.iam.gserviceaccount.com`
4. **치환 변수(Substitution variables)** 등록:

| 변수명 | 예시/설정값 | 비고 |
|---|---|---|
| `_REGION` | `asia-northeast3` | 서울 리전 |
| `_AR_REPOSITORY` | `hujimap` | Artifact Registry 저장소 |
| `_SERVICE_NAME` | `hujimap-staging` | Cloud Run 서비스 이름 |
| `_RUN_SERVICE_ACCOUNT` | `hujimap-runner@<PROJECT_ID>.iam.gserviceaccount.com` | 런타임 서비스 계정 |
| `_PAYMENT_MODE` | `disabled` (QA 시에만 `test`) | `live` 절대 금지 |
| `_APP_URL` | `https://<SERVICE_URL>` | 9단계에서 URL 확인 후 입력 |
| `_ALLOWED_APP_HOSTS` | `<SERVICE_HOST>` | 선택 사항 (쉼표 구분 허용 호스트) |
| `_NEXT_PUBLIC_APP_URL` | `https://<SERVICE_URL>` | 선택 사항 (빌드 시점 주입) |
| `_NEXT_PUBLIC_SUPABASE_URL` | `https://<SUPABASE_PROJECT_REF>.supabase.co` | 공개 URL |
| `_NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | `<SUPABASE_PUBLISHABLE_KEY>` | 공개 Publishable 키 |
| `_NEXT_PUBLIC_KAKAO_MAP_JS_KEY` | `<KAKAO_JS_KEY>` | 카카오 지도 JS 키 |
| `_NEXT_PUBLIC_TOSS_TEST_CLIENT_KEY` | `test_ck_...` (또는 빈 값) | `live_` 금지 |
| `_NEXT_PUBLIC_ANALYTICS_ENABLED` | `false` (또는 `true`) | 분석 플래그 |

> [!WARNING]
> 치환 변수 목록에는 **절대로** `SUPABASE_SECRET_KEY`, `TOSS_TEST_SECRET_KEY`, `PIN_ENCRYPTION_KEY_BASE64` 원문 값을 넣지 마세요. 이 값들은 Cloud Build 로그나 트리거 설정 화면에 노출될 수 있으므로 Secret Manager 이름(`_SECRET_*`)만 연결합니다.

---

## 9. 최초 배포 URL 확인 및 `APP_URL` 확정

1. **Cloud Run → `hujimap-staging` → 상단 URL** 확인 또는 CLI 실행:

```bash
gcloud run services describe hujimap-staging \
  --region=asia-northeast3 \
  --format="value(status.url)"
```

2. 확인된 URL(예: `https://hujimap-staging-xxxxxxxxxx-du.a.run.app`)을 다음에 반영합니다.
   - Cloud Build 트리거의 `_APP_URL`, `_ALLOWED_APP_HOSTS`(도메인 부분), `_NEXT_PUBLIC_APP_URL` 업데이트
   - 즉시 런타임에만 먼저 반영하려면(재빌드 불필요):

```bash
gcloud run services update hujimap-staging \
  --region=asia-northeast3 \
  --update-env-vars="APP_URL=https://<SERVICE_HOST>,ALLOWED_APP_HOSTS=<SERVICE_HOST>"
```

---

## 10. Supabase Auth Site URL 및 Redirect URL 설정

원격 Supabase 대시보드에서 Cloud Run 배포 도메인을 허용해야 회원가입 인증 메일 및 세션 리다이렉트가 정상 동작합니다.

1. [Supabase Dashboard](https://supabase.com/dashboard) → 대상 프로젝트 선택
2. **Authentication → URL Configuration** 이동
3. **Site URL** 설정:
   - `https://<CLOUD_RUN_SERVICE_HOST>` (예: `https://hujimap-staging-xxxxxxxxxx-du.a.run.app`)
4. **Redirect URLs**에 추가:
   - `https://<CLOUD_RUN_SERVICE_HOST>/**`
   - `https://<CLOUD_RUN_SERVICE_HOST>/login`
   - (로컬 병행 개발 시) `http://localhost:3000/**` 유지

---

## 11. Kakao JavaScript SDK 허용 도메인 등록

카카오 지도는 등록되지 않은 도메인에서 SDK 로드를 차단합니다.

1. [Kakao Developers](https://developers.kakao.com/) → 내 애플리케이션 → 해당 앱 선택
2. **앱 설정 → 플랫폼 → Web → 사이트 도메인** 수정
3. Cloud Run URL 등록:
   - `https://<CLOUD_RUN_SERVICE_HOST>` (경로 없이 프로토콜+도메인만 등록)
   - 기존 `http://localhost:3000` 유지

---

## 12. 배포 후 정상 동작 확인

1. **비회원 지도 접근**: `https://<CLOUD_RUN_SERVICE_HOST>/map` 접속 → 200 응답 및 카카오 지도 타일·공공화장실 목록 확인
2. **보안 가드 확인**:
   - `GET https://<CLOUD_RUN_SERVICE_HOST>/api/v1/auth/guard?summary=1` → **404 Not Found** 반환 확인 (Cloud Run에서 진단 API 차단)
   - `e2e_mock_*` 쿠키 전송 시에도 Mock 로그인 미동작 확인
3. **권한 분리 확인**:
   - 비로그인 상태에서 `/my/access`, `/my/receipts`, `/merchant/businesses`, `/admin` 접근 시 401/로그인 안내 확인
   - 일반 회원으로 `/admin`, `/merchant/restrooms` 접근 시 403 확인
4. **결제/PIN 안전성 확인**:
   - `_PAYMENT_MODE=disabled`일 때 결제 버튼 안전 차단 확인
   - `_PAYMENT_MODE=test`일 때 테스트 결제창만 동작하고 실결제(`live_`) 불가 확인

---

## 13. 배포 실패 시 로그 확인

1. **빌드/배포 단계 실패 (Cloud Build)**:
   - 콘솔: **Cloud Build → 기록 → 실패한 빌드 선택** 후 `validate-config`, `build-image`, `push-image`, `deploy-cloud-run` 단계 로그 확인
   - CLI:

```bash
gcloud builds list --region=asia-northeast3 --limit=5
gcloud builds log <BUILD_ID> --region=asia-northeast3
```

2. **런타임 오류 (Cloud Run 컨테이너)**:
   - 콘솔: **Cloud Run → `hujimap-staging` → 로그(Logs)** 탭 확인
   - CLI:

```bash
gcloud logging read \
  'resource.type="cloud_run_revision" AND resource.labels.service_name="hujimap-staging"' \
  --limit=50 \
  --format="table(timestamp,severity,textPayload)"
```

> [!IMPORTANT]
> 오류 로그에서도 비밀키, PIN 평문, 사용자 비밀번호가 출력되지 않는지 점검하세요.

---

## 14. 이전 Revision으로 롤백하는 방법

새 버전 배포 후 문제가 발생하면, 이전 정상 Revision으로 트래픽을 100% 전환해 즉시 롤백할 수 있으며 **기존 서비스 URL은 그대로 유지**됩니다.

1. 콘솔: **Cloud Run → `hujimap-staging` → 수정 및 새 버전 배포(또는 버전/Revisions 탭)** → 이전 정상 Revision 선택 → **트래픽 관리 → 100%** 할당
2. CLI:

```bash
# Revision 목록 확인
gcloud run revisions list \
  --service=hujimap-staging \
  --region=asia-northeast3

# 이전 정상 Revision으로 트래픽 100% 즉시 롤백
gcloud run services update-traffic hujimap-staging \
  --region=asia-northeast3 \
  --to-revisions=<PREVIOUS_REVISION_NAME>=100
```

---

## 15. 비용과 사용량 확인 방법

1. **Cloud Run 메트릭**: **Cloud Run → `hujimap-staging` → 측정항목(Metrics)**에서 요청 수, 컨테이너 인스턴스 수(0~2), CPU/메모리 사용률, 5xx 에러율을 확인합니다.
2. **예산 및 청구 알림 설정 (권장)**:
   - **결제(Billing) → 예산 및 알림 → 예산 만들기**
   - 프로젝트 `HUJIMAP-MVP` 대상 월 예산(예: 10,000원 등 소액 테스트 한도)과 50% / 90% / 100% 이메일 알림을 설정합니다.
3. **Artifact Registry 용량 관리**:
   - 오래된 Docker 이미지가 누적되면 스토리지 비용이 발생하므로 Artifact Registry 정리 정책(Cleanup policies)을 설정해 최근 N개 태그만 보관하세요.

---

## 부록: 배포 이후 원격 Supabase에서 별도로 필요한 작업 체크리스트

이번 배포 준비 작업에서는 원격 Supabase 스키마와 데이터를 변경하지 않았습니다. 실제 스테이징 서비스 운영 전, 아래 항목을 별도로 점검·실행하세요.

- [ ] **마이그레이션 동기화 확인**: `npx supabase migration list --remote`로 로컬과 원격 마이그레이션(17건 등 최신 상태) 일치 여부 확인
- [ ] **공공화장실 데이터(586건) 적재**: 원격 Supabase에는 공공화장실 데이터 586건이 아직 적재되지 않았으므로, `docs/import_runbook.md` 절차에 따라 원격 대상 `--dry-run` 확인 후 사용자 승인 하에 `--live --confirm` 적재 실행
- [ ] **`feature_flags` 확인**: `public_restroom_discovery`, `partner_restroom_discovery`, `payment_test_mode` 활성화 여부를 운영/스테이징 목적에 맞게 확인
- [ ] **Private Storage 버킷 확인**: `receipts` 및 화장실 사진 버킷의 비공개(`public = false`) 설정 및 RLS 정책 동작 확인
- [ ] **Auth URL Configuration**: 위 10단계의 Site URL 및 Redirect URLs 등록 완료 확인
- [ ] **테스트 계정 분리**: 스테이징 QA 계정에 `DEMO/TEST` 구분이 명확한지 확인하고 실제 사용자 개인정보가 유입되지 않도록 관리
