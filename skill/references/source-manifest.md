# Source manifest — sla-credit-recovery

확인 목적: Google Cloud Compute Engine SLA 위반/크레딧 후보 판단을 위한 v1 규칙 근거를 현재 공식 공개 문서에서 확인.

확인 일시(UTC): 2026-08-29 수행 (스킬 작성 시점 기준 최신 공개 문서 사용)

## 사용한 공식 문서

| 문서 | URL | 확인한 내용 | v1 반영 |
|------|-----|-------------|---------|
| Compute Engine SLA (현재) | https://cloud.google.com/compute/sla | Covered Service, Premium/Standard Tier SLO, Single Instance credit tier, Downtime/Downtime Period 정의, calendar month basis, Customer Must Request Financial Credit 절, Maximum Financial Credit 절, SLA Exclusions, Monthly Uptime Percentage 정의 | confirmed |
| Compute Engine SLA (현재, 일본어) | https://cloud.google.com/compute/sla?hl=ja | 현재 페이지의 동일 내용(Single Instance all other families credit tier, Customer Must Request Financial Credit 절, Maximum Financial Credit 절, SLA Exclusions, Monthly Uptime Percentage 정의) | confirmed (현재 페이지 재확인) |
| Network Service Tiers 개요 | https://cloud.google.com/network-tiers/docs/overview | Premium/Standard Tier 정의, external IP 지원 범위, SLA 링크 | confirmed (범위 식별용) |
| Machine families resource guide | https://cloud.google.com/compute/docs/machine-resource | machine family 분류(일반-purpose/memory-optimized 등), E2 위치 확인 | confirmed (family 분류 판단용) |
| Memory-optimized machines | https://cloud.google.com/compute/docs/memory-optimized-machines | Memory optimized family 구성(X4, M4N, M4, M3, M2, M1) 확인 | confirmed (E2가 해당 아님을 판단) |
| Preemptible VM instances | https://cloud.google.com/compute/docs/instances/preemptible | Preemptible이 Compute Engine SLA에서 제외된다는 명시적 기술 | confirmed (out-of-scope 근거) |
| Spot VMs | https://cloud.google.com/compute/docs/instances/spot | Spot VM이 Compute Engine SLA에서 제외된다는 명시적 기술 | confirmed (out-of-scope 근거) |
| Google Cloud Platform SLA 연락처 | https://support.google.com/cloud/contact/cloud_platform_sla | 공식 SLA 문의/제출용 지원 연락처 페이지 존재 확인 | confirmed (제출 경로 안내용) |

## 규칙별 출처 매핑

- **SLO (Single Instance, Premium, all other families)**: Compute Engine SLA (현재) — Premium Tier, Cloud Regions (excluding Mexico and Stockholm), "A Single Instance of all other families" → >= 99.9%.
- **Credit tier (Single Instance)**: Compute Engine SLA (현재) — Single Instance of all other families: 95.00%–<99.90% → 10%, 90.00%–<95.00% → 25%, <90.00% → 100%.
- **Downtime 정의**: Compute Engine SLA (현재) — VM 인스턴스 Downtime = loss of external connectivity 또는 persistent disk access.
- **Downtime Period 규칙**: Compute Engine SLA (현재) — 1분 이상 연속 Downtime만 집계, 1분 미만/간헐적은 미집계.
- **Monthly Uptime Percentage 정의**: Compute Engine SLA (현재) — total number of minutes in a month, minus the number of minutes of Downtime suffered from all Downtime Periods in a month, divided by the total number of minutes in a month. calendar month 단위.
- **Single Instance 단위**: Compute Engine SLA (현재) — "for a Single Instance, per instance".
- **청구 통지/증거 요건**: Compute Engine SLA 현재 페이지의 "Customer Must Request Financial Credit" 절 — 통지 기한(60일), log files 요건.
- **Maximum Financial Credit**: Compute Engine SLA 현재 페이지의 "Maximum Financial Credit" 절 — 단일 billing month 총액이 해당 월에 SLO를 충족하지 못한 지역의 Covered Services에 대해 due한 금액을 초과하지 않음.
- **Spot/Preemptible 제외**: Preemptible VM instances / Spot VMs 문서 — Compute Engine SLA에서 제외됨 명시.
- **E2의 family 분류**: Machine families resource guide + Memory-optimized machines 문서 — E2는 general-purpose, memory-optimized 아님 → "all other families"로 분류.

## Unresolved / 확인 필요 항목

- "eligible to receive a Financial Credit" 시점의 정확한 기준점(예: 월 마감 시점, 클레임 가능 시점 등)
- deadline의 정확한 timezone 또는 마지막 순간 포함 여부
- "log files showing Downtime Periods"의 구체적 증거 종류/범위
- Maximum Financial Credit cap의 정확한 수치/해석(과거 버전의 50% cap과 현재 문구가 다를 수 있음)
- 고객별 Order Form / reseller / offline agreement — 입력에 없으면 존재 가정하지 않음

## 범위 판단 근거 (v1)

- v1 대상: Google Cloud Compute Engine, Premium Network Tier, Single Instance, E2 machine series, standard provisioning, external connectivity loss, 하나의 instance, 하나의 NIC, 하나의 network tier, 하나의 closed calendar month.
- E2는 general-purpose이므로 "all other families"로 간주 → SLO 99.9%, Single Instance credit tier 적용.
- Spot/Preemptible은 공식 문서상 Compute Engine SLA에서 제외 → out-of-scope.

## 참고한 비-Google 자료 (보조 정보, 규칙 채택 근거로는 미채택)

- https://sla.directory/vendors/gcp/ — SLA 프로파일 요약(2026-06-23 확인 표기). 공식 문서 대체 아님. 청구 창 60 days of incident 등 요약이 있으나, Compute Engine SLA 본문/현재 페이지의 60일 요건과 차이가 있어 확정 근거로 사용하지 않음.
- 타 블로그/가이드(breachr.dev, complaya.ai, nextsignal.io 등) — 제출 절차 예시 참고용으로 확인했으나, 공식 규칙 채택 근거로 사용하지 않음.

출처 URL은 모두 위 표에 명시.
