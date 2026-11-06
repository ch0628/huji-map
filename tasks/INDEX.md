# Tasks index (한 번에 한 개만 실행)

의존성은 **앞 단계 PASS 후 다음 단계**이다. 외부 키가 없어서 해당 연동만 BLOCKED면 다음 단계 진행 여부를 사용자와 검토하되 성공으로 표시하지 않는다.

| 작업 | 목표 |
| [00](./00_workspace_inventory.md) | 워크스페이스 검사/상태 추적 |
| [01](./01_nextjs_scaffold.md) | Next.js 기본 화면 및 폴더 생성 |
| [02](./02_quality_setup.md) | 테스트·정적분석 도구만 구축 |
| [03](./03_auth_schema.md) | 회원/역할/방문 세션 DB 마이그레이션 |
| [04](./04_auth_ui.md) | 로그인 및 역할별 접근 가드 |
| [05](./05_lead_tracking.md) | 가게 접촉 50곳 리드/기록 |
| [06](./06_business_backend.md) | 가게 관리 DB 및 서버 API |
| [07](./07_business_ui.md) | 가게 등록 모바일 폼/목록 |
| [08](./08_business_approval.md) | 관리자 가게 검증 및 승인 |
| [09](./09_restroom_schema.md) | 공공·제휴 화장실 DB |
| [10](./10_catalog_api.md) | 화장실 조회 및 공개 정보 API |
| [11](./11_public_import.md) | 공공 화장실 데이터 수집기 |
| [12](./12_restroom_merchant_api.md) | 가게 화장실 관리 API |
| [13](./13_restroom_merchant_ui.md) | 가게 화장실 등록 화면 |
| [14](./14_restroom_admin_review.md) | 관리자 화장실 공개 승인 |
| [15](./15_map_provider.md) | 카카오 지도 공급자 어댑터 |
| [16](./16_map_discovery_ui.md) | 지도 카드·상세·길찾기 UX |
| [17](./17_events_backend.md) | 이벤트 저장 DB/API |
| [18](./18_events_ui_hooks.md) | 지도/버튼에 이벤트 연결 |
| [19](./19_pmf_dashboard.md) | H1/H2/H5 잠정 집계 리포트 |
| [20](./20_payment_schema.md) | 테스트 보증금 주문·이용권 DB |
| [21](./21_toss_server.md) | 토스 테스트 결제 서버 승인 |
| [22](./22_toss_checkout_ui.md) | 제휴 화장실 테스트 결제 UI |
| [23](./23_pin_storage.md) | 도어락 비밀 저장/교체 |
| [24](./24_pin_reveal.md) | 유효 이용권에만 PIN 공개 API |
| [25](./25_pin_ui.md) | 고객 이용권·PIN 확인 화면 |
| [26](./26_receipt_backend.md) | 영수증 비공개 저장·API |
| [27](./27_receipt_customer_ui.md) | 고객 영수증 업로드·상태 화면 |
| [28](./28_manual_review_backend.md) | 관리자 수동 심사 API |
| [29](./29_manual_review_ui.md) | 관리자 영수증 심사 화면 |
| [30](./30_refund_server.md) | 승인된 영수증의 테스트 환급 API |
| [31](./31_refund_admin_ui.md) | 관리자 환급 진행 화면 |
| [32](./32_integration_deploy.md) | E2E·보안 점검·배포 준비 |
