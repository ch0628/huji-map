# User account/API-key checklist (필요한 단계에만)

| 언제 | 준비할 것 | 사용자 조작 최소화 원칙 |
|---|---|---|
| TASK 03~04 | Supabase 프로젝트 URL/anon(공개) 키/service role(서버 전용) | 프로젝트 만들고 키를 Antigravity에 **보안 환경변수로** 입력. 채팅에 비밀키 붙여넣지 않기 |
| TASK 15 | Kakao Developers JS 키 및 도메인 등록 | localhost:3000과 배포 도메인 등록, 활성화 확인 |
| TASK 21~22 | Toss Payments **test** client/secret keys | `test_` 접두사만, 실거래 키·가맹점 활성화 필요 없음 |
| TASK 23~24 | 테스트 가게의 도어락 사용 허가 | 실제 입장 가능한 PIN은 가게 소유자의 명시적 승인을 얻은 경우에만 등록 |
| TASK 32 | Vercel 계정·배포 도메인 | 에이전트가 접근 허가된 경우에만 배포, 비밀환경변수 분리 |

없어도 설계·프론트 코드·단위 테스트는 진행 가능. 단 연동이 실제 성공했다고 보고하면 안 된다.

