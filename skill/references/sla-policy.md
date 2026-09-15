# SLA policy — sla-credit-recovery v1

이 파일은 스킬의 판단 근거가 되는 규칙을 기록합니다. 규칙에 사용한 출처와 URL은 `references/source-manifest.md`를 참조하세요.

## 0. 원칙

- 이 정책은 Google Cloud Compute Engine SLA 클레임 **판단·계산·정리**를 위한 룰셋입니다. 실제 클레임 승인이나 법률 자문을 대체하지 않습니다.
- 공식 문서에서 확인되지 않은 사항은 확정하지 않고 **UNRESOLVED** 또는 **NEEDS_REVIEW**로 남깁니다.
- 서로 다른 공식 문서가 다른 범위를 말할 때는, 현재 v1 대상(Premium / Single Instance / "all other families" / external connectivity loss)에 **직접 적용되는 조항**을 우선합니다.

## 1. In-scope (v1 자동 판정 대상)

하나씩 모두 만족하면 in-scope으로 처리합니다.

- Google Cloud Compute Engine
- Network Service Tier: **Premium**
- Covered Service: **Single Instance**
- Machine series: **E2**
- Provisioning: **standard** (preemptible/spot 아님)
- Downtime 유형: **external connectivity loss**
- 구성 단위: 하나의 instance, 하나의 NIC, 하나의 network tier
- 기간 단위: 하나의 **closed calendar month**

### 가족 분류 확인

- E2는 general-purpose machine family에 속하고, memory-optimized family에는 해당하지 않습니다.
- Compute Engine SLA(현재)는 Single Instance에 대해 "A Single Instance of Memory Optimized family"와 "A Single Instance of all other families"를 구분합니다.
- v1 대상은 "all other families"로 분류합니다.

출처: Compute Engine SLA (현재), Machine families resource guide, Memory-optimized machines 문서 (출처 URL은 source-manifest 참조).

## 2. Out-of-scope (자동 판정하지 않음)

아래 중 하나라도 해당하면 `OUT_OF_SCOPE`로 종료합니다. 현재 scope의 SLO/credit 규칙을 억지 적용하지 않습니다.

- Network Service Tier가 **Standard**이거나, 한 달 중 tier가 변경된 경우
- Machine series가 **E2가 아닌** 경우 (non-E2)
- Instance가 **Spot / Preemptible**인 경우
- **Instances in Multiple Zones** 묶음 계산인 경우
- NIC가 여러 개이거나, 어느 NIC의 장애인지 불명확한 경우
- Persistent Disk 단독 장애만 있는 경우
- 대상이 **Compute Engine 외 다른 Google Cloud 서비스**인 경우
- 월이 **closed가 아님** (진행 중/미래 월)
- 입력이 부족해 scope 자체를 판단할 수 없는 경우

Spot/Preemptible 제외 근거는 Compute Engine 공식 문서(Preemptible VM instances, Spot VMs)에 명시되어 있습니다.

## 3. SLO (Service Level Objective)

v1 대상(Premium, Cloud Regions excluding Mexico and Stockholm, Single Instance, all other families)의 Monthly Uptime Percentage SLO:

- **≥ 99.9%**

지역 범주별로 SLA가 다르게 제시된 경우(멕시코/스톡홀름)는 별도 플래그로 확인 필요하며, 기본 판정에서는 "Cloud Regions (excluding Mexico and Stockholm)" 기준을 적용하고 해당 region 여부는 입력으로 확인합니다.

출처: Compute Engine SLA (현재).

## 4. Calendar month / 월 분 계산

- Monthly Uptime Percentage는 **calendar month** 단위입니다.
- Single Instance는 instance 단위입니다.
- 월 총 분(분모)은 해당 calendar month의 실제 길이로 계산합니다.
- 윤초 등의 특수 처리는 v1에서 별도 취급하지 않고, month의 calendar minute 수를 사용합니다.

계산은 분 단위 정수로 수행합니다(결정론적 처리).

## 5. Downtime 정의

- VM 인스턴스의 Downtime은 **loss of external connectivity** 또는 **persistent disk access**입니다.
- v1은 이 중 **external connectivity loss**만 다룹니다.
- Persistent disk access 단독 문제만으로는 외부 연결 손실로 보지 않습니다(입력에서 external connectivity loss로 명시/증거된 경우만 취급).

출처: Compute Engine SLA (현재).

## 6. Downtime Period 규칙

- Downtime Period는 **1분 이상 연속된 Downtime**입니다.
- 1분 미만의 부분 분 또는 간헐적 Downtime(1분 미만 구간의 연속/반복)은 **Downtime Period로 집계하지 않습니다**.
- 이 규칙은 SLA 정의에 따른 집계 단위 규칙이며, 계산기에서도 분 단위 정수 기준으로 처리합니다.

출처: Compute Engine SLA (현재).

## 7. Incident interval 처리 (결정론적 순서)

입력으로 주어진 outage interval들에 대해 다음 순서로 처리합니다.

1. RFC3339 → UTC 정규화
2. 해당 calendar month 경계로 clip/split (월 밖 시간은 제외)
3. 동일 scope(동일 instance/NIC/tier/월)의 구간만 취급
4. 겹치거나 중복인 구간 union (중복 합산 금지)
5. 확인된(verified) exclusion interval union
6. gross downtime에서 **verified exclusion만** 차감
7. 남은 eligible interval 재구성
8. Downtime Period 규칙(1분 미만 미집계)에 따라 적격 downtime 계산

금지:
- 다른 VM/NIC/tier의 사고 병합
- exclusion 여러 번 차감
- 일부 exclusion이 있다고 전체 장애를 제외
- 월 경계 밖 시간 포함

계산 결과는 trace로 남깁니다:
- union 전 contributing incident 수
- union 후 eligible interval 수
- verified exclusion 수
- gross outage 분
- eligible outage 분
- `eligible_outage <= gross_outage` 확인

## 8. Monthly Uptime Percentage (MUP)

```
MUP = (월 총 분 - eligible outage 분) / 월 총 분
```

- 분자는 정수, 분모는 정수.
- unrounded 값을 **판정용**으로 사용합니다.
- 표시용 값은 별도 반올림해 보여도 되고, 판정에는 쓰지 않습니다.
  - 예: 표시 99.90이어도 unrounded가 99.9014...이면 99.9 SLO 경계 위반으로 판정하지 않음.
- edge case: MUP가 정확히 경계값과 같으면, SLA 표에 제시된 범위 표기법(<, ≥)에 맞춰 inclusive/exclusive 규칙으로 판정합니다. 이 스킬은 SLA 표의 범위를 그대로 사용합니다.

## 9. Single Instance credit tier (v1 대상)

Compute Engine SLA(현재) 기준, Premium Tier, Cloud Regions (excluding Mexico and Stockholm), Single Instance of all other families 기준 credit:

| Monthly Uptime Percentage | Financial Credit (% of monthly bill for the Single Instance in the Region) |
|---------------------------|----------------------------------------------------------------------------|
| 95.00% – < 99.90%        | 10%                                                                        |
| 90.00% – < 95.00%        | 25%                                                                        |
| < 90.00%                 | 100%                                                                       |

판정 규칙:
- SLO(99.9%)를 충족하면 credit tier 없음.
- SLO 위반 시 위 표에서 MUP 범위대로 tier 결정.
- **MUP가 99.90% 이상이면** Single Instance credit tier 표의 적용 범위 밖(99.90% 이상 구간에는 이 표에 100%/25%/10% 항목이 없음). 이 경우 해당 표 기준으로는 credit tier가 없다고 처리합니다(범위는 표 기준). 다만 SLO 자체는 99.9%이므로, MUP가 99.9% 이상 99.90% 미만이면 SLO 충족으로 credit 없음으로 봅니다.

**주의**: 위 tier 표는 현재 SLA 페이지 기준입니다. 과거 버전에는 다른 표기가 존재할 수 있습니다. 현재 공식 페이지를 기준으로 채택하되, 문서 버전 차이에 따라 tier 표가 달라질 수 있다는 점은 **NEEDS_REVIEW** 사유가 될 수 있습니다.

출처: Compute Engine SLA (현재). 과거 버전 비교는 source-manifest 참조.

## 10. Financial Credit 금액

- SLA 표에는 **월간 이용요금 대비 비율(%)**만 제시되어 있습니다.
- 실제 금액(통화 minor unit, 반올림 방식)은 SLA 표만으로 확정되지 않습니다.
- billing basis(월 청구 금액 등)가 입력되고 검증되면 **provisional estimate**로 계산할 수 있습니다.
- billing scope 검증 여부와 credit amount certainty는 **separately** 표시합니다.
  - billing scope 미검증 → 금액은 PROVISIONAL
  - billing scope 부족만으로 breach 결론을 취소하지 않음

## 11. Spot / Preemptible

Spot VM 및 Preemptible VM은 Compute Engine SLA에서 제외된다고 공식 문서에 명시되어 있습니다.

출처: Preemptible VM instances, Spot VMs 문서 (출처 URL은 source-manifest 참조).

## 12. 청구 통지/증거 요건 (NEEDS_REVIEW 대상)

Compute Engine SLA 현재 페이지에는 다음과 같은 요건이 명시되어 있습니다.

- Customer must notify Google technical support within 60 days from the time Customer becomes eligible to receive a Financial Credit.
- Customer must provide Google with log files showing Downtime Periods and the date and time they occurred.
- 미준수 시 Financial Credit 권리 상실 가능성.

다만 다음 항목은 **현재 문서에서 확정되지 않았으므로** 자동 확정하지 않습니다.

- "eligible to receive a Financial Credit" 시점의 정확한 기준점(예: 월 마감 시점, 클레임 가능 시점 등)
- deadline의 정확한 timezone 또는 마지막 순간 포함 여부
- "log files showing Downtime Periods"의 구체적 증거 종류/범위
- Maximum Financial Credit cap의 정확한 수치/해석(과거 버전의 50% cap과 현재 문구가 다를 수 있음)

따라서 evidence/기한은 다음과 같이 분리해서 다루고, 확정하지 못 할 경우 명시적으로 표시합니다.

- **outage log 충족 여부** (log files / Downtime Periods 증거)
- **notice 상태** (제출 여부, 제출 확인 등)
- **billing scope 검증 여부**
- **claim deadline 상태** (기한 충족 여부/경계 모호 여부)

출처: Compute Engine SLA 현재 페이지. 불확실한 세부 사항은 UNRESOLVED로 기록.

## 13. 제출 경로 (안내용)

공식 SLA 문의/제출용 지원 연락처 페이지가 존재합니다.

- https://support.google.com/cloud/contact/cloud_platform_sla

이 스킬은 실제 제출을 수행하지 않습니다. 제출 경로와 필요한 정보는 사람 검토용으로 정리할 수 있습니다.

## 14. UNRESOLVED / NEEDS_REVIEW 요약

현재 문서 확인 범위 기준, 다음 항목은 확정하지 않습니다.

- "eligible to receive a Financial Credit" 시점의 정확한 기준점
- deadline의 timezone / 마지막 순간 포함 여부
- credit 금액의 통화 minor unit/반올림 방식(SLA 표에는 비율만 있음)
- Maximum Financial Credit cap의 정확한 수치/해석
- "log files showing Downtime Periods"의 구체적 증거 종류/범위
- 고객별 Order Form, reseller, offline agreement 관련 사항 (입력 없으면 존재 가정하지 않음)
- SLA 버전 차이로 인한 tier 표 차이(현재 페이지 값과 과거 값 다름) — 계약/문서 버전에 따라 달라질 수 있음

이 항목들은 계산 결과와 Separately 표시하고, 필요한 경우 사람 검토로 연결합니다.
