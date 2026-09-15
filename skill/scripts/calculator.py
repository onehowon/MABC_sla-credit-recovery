#!/usr/bin/env python3
"""
sla-credit-recovery — deterministic calculator (v1)

계산만 담당합니다(판단/상태 머신 로직은 SKILL.md 쪽 흐름과 분리).
- RFC3339 → UTC 정규화
- calendar month clip/split
- incident union (동일 scope)
- verified exclusion union → gross 차감
- 분 단위 정수 연산으로 MUP 계산
- unrounded MUP로 tier 결정 (표시 반올림과 분리)
- invariant checks
- audit trace 출력

외부 입력을 신뢰하지 않고, 데이터로만 처리합니다(injection 방어: 이 파일은
입력 텍스트를 명령으로 실행하지 않습니다).
"""

from __future__ import annotations

import calendar
import datetime
from typing import Any, Dict, List, Optional, Tuple

# ---------------------------------------------------------------------------
# UTC/time handling
# ---------------------------------------------------------------------------

def _parse_offset(off: str) -> datetime.timedelta:
    """'+09:00' 또는 '-05:00' 또는 '+0900' 등을 timedelta로 파싱."""
    off = off.replace(":", "")
    sign = 1
    if off.startswith("-"):
        sign = -1
        off = off[1:]
    elif off.startswith("+"):
        off = off[1:]
    if len(off) == 4:
        h = int(off[:2])
        m = int(off[2:])
    elif len(off) == 2:
        h = int(off)
        m = 0
    else:
        raise ValueError(f"unsupported offset: {off!r}")
    return datetime.timedelta(hours=sign * h, minutes=sign * m)


def _parse_utc(ts: str) -> datetime.datetime:
    """RFC3339-ish 문자열을 UTC naive datetime으로 정규화합니다.

    fractional seconds, 'Z', +/-HH:MM offset을 모두 처리합니다.
    반환 값의 tzinfo는 제거(UTC 기준 naive)합니다.
    """
    s = ts.strip()

    offset: datetime.timedelta = datetime.timedelta(0)
    # timezone offset 분리
    if s.endswith("Z") or s.endswith("z"):
        s = s[:-1]
    elif "T" in s:
        date_part, time_part = s.split("T", 1)
        if "+" in time_part:
            t_part, off_part = time_part.split("+", 1)
            s = f"{date_part}T{t_part}"
            offset = _parse_offset(off_part)
        elif time_part.count("-") > 1:
            # time_part에 '-'가 2개 이상 => 오프셋 있음
            idx = time_part.rfind("-")
            t_part = time_part[:idx]
            off_part = time_part[idx + 1:]
            s = f"{date_part}T{t_part}"
            offset = _parse_offset("-" + off_part)
    else:
        # 날짜만 있는 경우에도 오프셋이 붙어 있을 수 있음(드뭄)
        if "+" in s:
            dp, op = s.split("+", 1)
            s = dp
            offset = _parse_offset(op)
        elif s.count("-") > 2:
            dp, op = s.rsplit("-", 1)
            s = dp
            offset = _parse_offset("-" + op)

    # fractional second 분리
    base_str = s
    if "." in s:
        prefix, rest = s.split(".", 1)
        idx = 0
        while idx < len(rest) and rest[idx].isdigit():
            idx += 1
        frac_str = rest[:idx]
        base_str = f"{prefix}.{frac_str}"

    dt = datetime.datetime.fromisoformat(base_str)
    dt = dt.replace(tzinfo=None)
    dt = dt - offset
    return dt


def _minute_floor(dt: datetime.datetime) -> datetime.datetime:
    return dt.replace(second=0, microsecond=0)


def _minute_ceil(dt: datetime.datetime) -> datetime.datetime:
    m = _minute_floor(dt)
    if m == dt:
        return m
    return m + datetime.timedelta(minutes=1)


def _calendar_month_bounds(year: int, month: int) -> Tuple[datetime.datetime, datetime.datetime]:
    """해당 calendar month의 시작과 다음 달 시작을 naive UTC로 반환합니다.

    month start: YYYY-MM-01 00:00:00
    month end(미만): 다음 달 00:00:00
    """
    start = datetime.datetime(year, month, 1, 0, 0, 0)
    _, last_day = calendar.monthrange(year, month)
    end = datetime.datetime(year, month, last_day, 0, 0, 0) + datetime.timedelta(days=1)
    return start, end


def _total_minutes_in_month(year: int, month: int) -> int:
    _, last_day = calendar.monthrange(year, month)
    return last_day * 24 * 60


def _clip_to_month(
    start: datetime.datetime, end: datetime.datetime, month_start: datetime.datetime, month_end: datetime.datetime
) -> Optional[Tuple[datetime.datetime, datetime.datetime]]:
    """월 경계로 구간을 clip합니다. 월과 겹치지 않으면 None."""
    if end <= month_start or start >= month_end:
        return None
    clip_start = max(start, month_start)
    clip_end = min(end, month_end)
    if clip_end <= clip_start:
        return None
    return clip_start, clip_end


# ---------------------------------------------------------------------------
# interval arithmetic
# ---------------------------------------------------------------------------

def _normalize_intervals(intervals: List[Tuple[datetime.datetime, datetime.datetime]]) -> List[Tuple[datetime.datetime, datetime.datetime]]:
    """각 구간을 [start, end)로 정규화하고 start<end만 남깁니다."""
    out: List[Tuple[datetime.datetime, datetime.datetime]] = []
    for s, e in intervals:
        if s < e:
            out.append((s, e))
    return out


def _union_intervals(intervals: List[Tuple[datetime.datetime, datetime.datetime]]) -> List[Tuple[datetime.datetime, datetime.datetime]]:
    """겹치거나 접점이 있는 분 단위 구간을 union합니다.

    minute 집계 목적상 접점이면 연속으로 이어진 것으로 union합니다.
    """
    if not intervals:
        return []
    items = sorted(intervals, key=lambda x: (x[0], x[1]))
    merged: List[List[datetime.datetime]] = [[items[0][0], items[0][1]]]
    for s, e in items[1:]:
        last = merged[-1]
        if s <= last[1]:
            if e > last[1]:
                last[1] = e
        else:
            merged.append([s, e])
    return [(a, b) for a, b in merged]


def _interval_total_minutes(intervals: List[Tuple[datetime.datetime, datetime.datetime]], minute_floor: bool) -> int:
    """union된 interval들의 총 분 수.

    minute_floor=True이면 시작과 끝을 분 단위로 align한 뒤 집계합니다.
    Downtime Period 규칙(1분 미만 미집계) 처리를 위해,
    - 시작: 분 단위 올림(ceil)
    - 끝: 분 단위 내림(floor)
    하되, ceil(start) >= floor(end) 이면 0으로 처리합니다.
    """
    total = 0
    for s, e in intervals:
        if minute_floor:
            fs = _minute_ceil(s)
            fe = _minute_floor(e)
            if fe <= fs:
                continue
            total += int((fe - fs).total_seconds() / 60)
        else:
            total += int((e - s).total_seconds() / 60)
    return total


# ---------------------------------------------------------------------------
# SLA policy constants (v1 대상, 현재 공식 문서 기준)
# ---------------------------------------------------------------------------

SLO_SINGLE_INSTANCE_PREMIUM_ALLOTHER = 99.9  # percent

# Single Instance credit tier (% of monthly bill for Single Instance in Region)
# 현재 Compute Engine SLA 기준, "all other families" 기준.
# 표 범위(미만/이상 표기 그대로):
#   95.00% - < 99.90%  -> 10%
#   90.00% - < 95.00%  -> 25%
#   < 90.00%           -> 100%
CREDIT_TIER_BOUNDS = [
    (95.00, 99.90, False, 10),
    (90.00, 95.00, False, 25),
    (0.0, 90.00, False, 100),
]


def _tier_from_mup(unrounded_mup: float) -> Optional[Tuple[int, str]]:
    """unrounded MUP로 credit tier를 결정합니다. 없으면 None.

    판정용 값(unrounded)만 사용합니다. 경계 해석이 애매한 경우 표 범위 기준으로
    inclusive/exclusive를 그대로 적용합니다.
    """
    if unrounded_mup >= 99.90:
        return None
    for lo, hi, hi_inclusive, credit in CREDIT_TIER_BOUNDS:
        if hi_inclusive:
            if lo <= unrounded_mup <= hi:
                return (credit, f"{lo:.2f}% – {hi:.2f}%")
        else:
            if lo <= unrounded_mup < hi:
                return (credit, f"{lo:.2f}% – < {hi:.2f}%")
    return None


# ---------------------------------------------------------------------------
# main calculation
# ---------------------------------------------------------------------------

def calculate(
    year: int,
    month: int,
    incidents: List[Dict[str, Any]],
    exclusions: Optional[List[Dict[str, Any]]] = None,
    *,
    family: str = "all other families",
    tier: str = "Premium",
    region_excludes_mexico_stockholm: bool = True,
    needs_review_reasons: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """v1 대상 Single Instance (Premium, all other families)의 월 MUP/티어를 결정한다.

    incidents: 각 항목은 {"start": RFC3339, "end": RFC3339} 또는 start/end 키.
    exclusions: 각 항목은 {"start": RFC3339, "end": RFC3339}. **verified만** 입력한다고 가정.
    """
    if needs_review_reasons is None:
        needs_review_reasons = []

    month_start, month_end = _calendar_month_bounds(year, month)
    total_month_minutes = _total_minutes_in_month(year, month)

    # 1) incident 파싱 + month clip
    raw_incident_pairs: List[Tuple[datetime.datetime, datetime.datetime]] = []
    clip_incidents: List[Tuple[datetime.datetime, datetime.datetime]] = []
    incident_count = 0
    for it in incidents:
        incident_count += 1
        start = _parse_utc(it["start"])
        end = _parse_utc(it["end"])
        raw_incident_pairs.append((start, end))
        clipped = _clip_to_month(start, end, month_start, month_end)
        if clipped is not None:
            clip_incidents.append(clipped)

    # 2) union
    normalized = _normalize_intervals(clip_incidents)
    union_incidents = _union_intervals(normalized)
    union_incident_count = len(union_incidents)

    # 3) gross outage (분): Downtime Period 규칙상 1분 미만 미집계.
    gross_outage_minutes = _interval_total_minutes(union_incidents, minute_floor=True)

    # 4) verified exclusions: 파싱 + month clip + union
    exclusion_pairs: List[Tuple[datetime.datetime, datetime.datetime]] = []
    exclusion_count = 0
    if exclusions:
        ex_clipped: List[Tuple[datetime.datetime, datetime.datetime]] = []
        for ex in exclusions:
            exclusion_count += 1
            es = _parse_utc(ex["start"])
            ee = _parse_utc(ex["end"])
            c = _clip_to_month(es, ee, month_start, month_end)
            if c is not None:
                ex_clipped.append(c)
        ex_normalized = _normalize_intervals(ex_clipped)
        ex_union = _union_intervals(ex_normalized)
        exclusion_pairs = ex_union
    exclusion_count_final = len(exclusion_pairs)

    # 5) eligible = gross - verified exclusion (구간 단위로 차감)
    verified_exclusion_minutes = _interval_total_minutes(exclusion_pairs, minute_floor=True)
    eligible_outage_minutes = max(gross_outage_minutes - verified_exclusion_minutes, 0)

    # internal consistency check
    consistent = eligible_outage_minutes <= gross_outage_minutes

    # 6) MUP
    if total_month_minutes <= 0:
        mup = None
    else:
        mup = (total_month_minutes - eligible_outage_minutes) / total_month_minutes * 100.0

    unrounded_mup = mup
    mup_display = round(mup, 2) if mup is not None else None

    # 7) SLO 판정 (unrounded)
    slo_breached = False
    if mup is None:
        slo_breached = None  # 계산 불가
    else:
        slo_breached = mup < SLO_SINGLE_INSTANCE_PREMIUM_ALLOTHER

    # 8) credit tier (unrounded 기반)
    tier_info: Optional[Tuple[int, str]] = None
    if mup is not None and slo_breached:
        tier_info = _tier_from_mup(mup)

    # 9) audit trace
    trace: Dict[str, Any] = {
        "rule_set": "compute-engine-sla-current-premium-single-instance-all-other-families",
        "slo_percent": SLO_SINGLE_INSTANCE_PREMIUM_ALLOTHER,
        "credit_tier_table_source": "cloud.google.com/compute/sla (current)",
        "total_month_minutes": total_month_minutes,
        "incident_count_before_union": incident_count,
        "incident_count_after_union": union_incident_count,
        "exclusion_count_input": exclusion_count,
        "exclusion_count_after_union": exclusion_count_final,
        "gross_outage_minutes": gross_outage_minutes,
        "verified_exclusion_minutes": verified_exclusion_minutes,
        "eligible_outage_minutes": eligible_outage_minutes,
        "eligible_le_gross": bool(consistent),
        "unrounded_mup_percent": unrounded_mup,
        "mup_display_percent": mup_display,
        "slo_breached": slo_breached,
        "tier_from_unrounded_mup": tier_info,
        "family": family,
        "tier": tier,
        "exclusion_handling_note": "verified exclusion만 차감; 미검증/추정 제외는 차감하지 않음",
        "minute_floor_note": "1분 미만 Downtime Period는 미집계 (SLA Downtime Period 규칙)",
        "out_of_scope_reasons": [],
        "needs_review_reasons": list(needs_review_reasons),
    }

    return {
        "status": "CALCULATED",
        "month": {"year": year, "month": month},
        "family": family,
        "tier": tier,
        "slo_percent": SLO_SINGLE_INSTANCE_PREMIUM_ALLOTHER,
        "total_month_minutes": total_month_minutes,
        "gross_outage_minutes": gross_outage_minutes,
        "verified_exclusion_minutes": verified_exclusion_minutes,
        "eligible_outage_minutes": eligible_outage_minutes,
        "eligible_le_gross": consistent,
        "unrounded_mup_percent": unrounded_mup,
        "mup_display_percent": mup_display,
        "slo_breached": slo_breached,
        "credit_tier": tier_info,
        "trace": trace,
    }


def estimate_credit_amount(
    credit_tier_percent: int,
    monthly_bill_units: Optional[int],
    billing_scope_verified: bool,
) -> Dict[str, Any]:
    """credit tier %로부터 금액 추정(provisional).

    monthly_bill_units: 청구 기준 금액(정수, minor unit 예: cents). None이면 추정 불가.
    billing_scope_verified: billing scope 검증 여부에 따라 certainty 결정.
    """
    if monthly_bill_units is None:
        return {
            "credit_tier_percent": credit_tier_percent,
            "monthly_bill_units": None,
            "estimated_amount_units": None,
            "amount_certainty": "NOT_PROVISIONED",
            "note": "billing basis 미입력으로 금액 추정 불가",
        }

    units = monthly_bill_units * credit_tier_percent // 100
    return {
        "credit_tier_percent": credit_tier_percent,
        "monthly_bill_units": monthly_bill_units,
        "estimated_amount_units": units,
        "amount_certainty": "PROVISIONAL" if not billing_scope_verified else "PROVISIONAL",
        "note": "credit 금액 반올림/통화 minor unit 처리 방식은 SLA 표만으로 확정되지 않음. 입력값이 검증되지 않았으면 PROVISIONAL로 표시.",
    }


def policy_audit() -> Dict[str, Any]:
    """현재 공식 문서 기준 policy audit 요약(자동 생성 아님, 논리 전용).

    이 함수는 스킬 외부의 정책 검토를 대체할 수 없습니다.
    """
    return {
        "version": "v1",
        "sla_source": "cloud.google.com/compute/sla (current)",
        "single_instance_slo_premium_allother": SLO_SINGLE_INSTANCE_PREMIUM_ALLOTHER,
        "credit_tier_table": [
            {"mup_range": "95.00% – < 99.90%", "credit_percent": 10},
            {"mup_range": "90.00% – < 95.00%", "credit_percent": 25},
            {"mup_range": "< 90.00%", "credit_percent": 100},
        ],
        "deadline_anchor_resolved": False,
        "deadline_timezone_resolved": False,
        "maximum_credit_cap_fixed_numeric": False,
        "required_evidence_log_type_fixed": False,
        "billing_amount_certainty_default": "PROVISIONAL",
    }
