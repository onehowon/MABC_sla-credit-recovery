# Google Cloud 자동 탐색 연결

이 앱의 자동 탐색은 사용자가 Google 계정으로 명시적으로 동의한 짧은 수명의 OAuth access token을 사용합니다.

- 서비스 계정 키나 access token을 저장소에 넣지 않습니다.
- Vercel API는 전달받은 token으로 Compute/Logging을 읽기만 하며 저장하지 않습니다.
- GCP 리소스 생성·변경·삭제, SLA claim 자동 제출은 하지 않습니다.

## 1. Google Cloud에서 준비할 것

1. OAuth 동의 화면을 설정합니다.
2. **Web application** OAuth Client ID를 만듭니다.
3. Authorized JavaScript origins에 아래를 추가합니다.

   - `https://mabc-sla-credit-recovery.vercel.app`
   - 사용하는 커스텀 도메인(있다면)
   - 로컬 개발 주소(필요할 때만, 예: `http://localhost:3000`)

4. 다음 API를 활성화합니다.

   - Compute Engine API
   - Cloud Logging API

5. 연결할 사용자에게 대상 프로젝트의 최소 읽기 IAM 권한을 부여합니다.

   - Compute Engine Viewer
   - Logs Viewer

## 2. Vercel 환경변수

Vercel 프로젝트의 Production 환경변수에 OAuth **Client ID**를 추가합니다.

```text
GOOGLE_OAUTH_CLIENT_ID=1234567890-...apps.googleusercontent.com
```

Client ID는 브라우저 OAuth 흐름에 사용되는 공개 식별자입니다. Client secret, 서비스 계정 JSON 키, access token은 넣지 않습니다.

환경변수를 저장한 뒤 Vercel을 재배포합니다.

## 3. 사용자 흐름

1. 닫힌 대상 월과 GCP project ID 입력
2. `GCP 연결하고 찾기` 클릭
3. Google 계정에서 Compute 읽기·Logging 읽기 권한 동의
4. E2 / Premium / 단일 NIC / Spot 제외 범위를 통과한 인스턴스만 선택
5. 장애 시작·종료 시각을 확인
6. 해당 시간 구간의 Cloud Logging 증거 후보 조회
7. `sla-credit-recovery` 스킬의 scope/evidence gate와 Frozen 계산기로 청구 준비 상태 정리

Cloud Logging 결과는 증거 **후보**입니다. 외부 연결 손실과 정확한 Downtime Period를 사람이 검토하기 전에는 `READY_FOR_HUMAN_CLAIM_REVIEW`로 자동 승격하지 않습니다.
