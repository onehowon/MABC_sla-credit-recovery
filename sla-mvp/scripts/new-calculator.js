/**
 * SLA Credit Recovery - Frozen 계산 로직 (JavaScript)
 * 
 * Python calculator.py와 동일 로직:
 * - RFC3339 파싱 (UTC 기준, Date.UTC 활용)
 * - 월 clip/split
 * - union
 * - 1분 미만 미집계 (floor rule)
 * - verified exclusion 차감
 * - raw MUP 기반 tier 판정
 * - readiness 판정
 */

'use strict';

// ─── RFC3339 파서 ────────────────────────────────────────────
// Python: _parse_utc 와 대응. Date.UTC로 UTC 기준 ms 계산.
function parseRFC3339ToUTC(dateStr) {
  if (!dateStr) return null;
  const s = String(dateStr).trim();
  if (!s) return null;

  // Z 제거 (UTC)
  let working = s;
  let offsetMinutes = 0;

  if (working.endsWith('Z') || working.endsWith('z')) {
    working = working.slice(0, -1);
  } else if (working.indexOf('T') >= 0) {
    const tIdx = working.indexOf('T');
    const datePart = working.substring(0, tIdx);
    const timePart = working.substring(tIdx + 1);

    if (timePart.indexOf('+') >= 0) {
      const plusIdx = timePart.indexOf('+');
      const tPart = timePart.substring(0, plusIdx);
      const offPart = timePart.substring(plusIdx + 1);
      working = datePart + 'T' + tPart;
      offsetMinutes = parseOffset(offPart);
    } else if (timePart.indexOf('-') >= 0 && timePart.match(/-/g).length > 1) {
      const lastDash = timePart.lastIndexOf('-');
      const tPart = timePart.substring(0, lastDash);
      const offPart = timePart.substring(lastDash + 1);
      working = datePart + 'T' + tPart;
      offsetMinutes = parseOffset('-' + offPart);
    }
  }

  // YYYY-MM-DDTHH:MM(:SS)? 파싱
  const m = working.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;

  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10) - 1;
  const day = parseInt(m[3], 10);
  const hour = parseInt(m[4], 10);
  const min = parseInt(m[5], 10);
  const sec = m[6] ? parseInt(m[6], 10) : 0;

  return { year, month, day, hour, min, sec, offsetMinutes };
}

function parseOffset(s) {
  s = s.replace(':', '');
  let sign = 1;
  if (s.indexOf('-') === 0) { sign = -1; s = s.substring(1); }
  else if (s.indexOf('+') === 0) s = s.substring(1);
  if (s.length === 4) return sign * (parseInt(s.substring(0, 2), 10) * 60 + parseInt(s.substring(2), 10));
  if (s.length === 2) return sign * parseInt(s, 10) * 60;
  return 0;
}

function dateToUTCms(d) {
  if (!d) return null;
  return Date.UTC(d.year, d.month, d.day, d.hour, d.min, d.sec || 0) + d.offsetMinutes * 60000;
}

// ─── 월 계산 ──────────────────────────────────────────────────
function monthBounds(year, month) {
  const start = Date.UTC(year, month - 1, 1, 0, 0, 0);
  const lastDay = new Date(Date.UTC(year, month, 0, 0, 0, 0)).getUTCDate();
  const end = Date.UTC(year, month - 1, lastDay, 0, 0, 0);
  return { start, end, totalMinutes: lastDay * 24 * 60 };
}

// 월 구간에 clip (Python: _clip)
function clip(start, end, monthStart, monthEnd) {
  if (end <= monthStart || start >= monthEnd) return null;
  const a = Math.max(start, monthStart);
  const b = Math.min(end, monthEnd);
  if (b <= a) return null;
  return [a, b];
}

// 구간 union (Python: _union)
function unionIntervals(intervals) {
  if (!intervals || intervals.length === 0) return [];
  const sorted = intervals.map(i => [i[0], i[1]]).sort((a, b) => a[0] - b[0]);
  const merged = [[sorted[0][0], sorted[0][1]]];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i][0] <= last[1]) {
      if (sorted[i][1] > last[1]) last[1] = sorted[i][1];
    } else {
      merged.push([sorted[i][0], sorted[i][1]]);
    }
  }
  return merged.map(pair => [pair[0], pair[1]]);
}

// 분 계산 - floor rule 적용 (Python: _minutes with floor_rule=True)
// 1분 미만 미집계: 시작 분은 ceil, 종료 분은 floor
function minutesWithFloorRule(intervals) {
  if (!intervals) return 0;
  let total = 0;
  for (const interval of intervals) {
    const fsDate = new Date(interval[0]);
    const feDate = new Date(interval[1]);
    const fs = new Date(Date.UTC(fsDate.getUTCFullYear(), fsDate.getUTCMonth(), fsDate.getUTCDate(),
                                fsDate.getUTCHours(), fsDate.getUTCMinutes(), 0, 0));
    if (fs.getTime() < interval[0]) fs = new Date(fs.getTime() + 60000);
    const fe = new Date(Date.UTC(feDate.getUTCFullYear(), feDate.getUTCMonth(), feDate.getUTCDate(),
                                feDate.getUTCHours(), feDate.getUTCMinutes(), 0, 0));
    if (fe.getTime() > interval[1]) fe = new Date(fe.getTime() - 60000);
    if (fe <= fs) continue;
    total += (fe - fs) / 60000;
  }
  return Math.round(total);
}

// ─── tier 판정 (Python: _tier) ──────────────────────────────
function calcTier(mup) {
  if (mup === null || mup === undefined) return null;
  if (mup >= 99.90) return null;
  if (mup >= 95.00) return { percent: 10, range: '95.00% – < 99.90%' };
  if (mup >= 90.00) return { percent: 25, range: '90.00% – < 95.00%' };
  return { percent: 100, range: '< 90.00%' };
}

// ─── readiness (Python: readiness) ──────────────────────────
function calcReadiness(sloBreached, evidenceStatus, billingVerified, deadlineBlocker) {
  if (sloBreached === null) {
    return { status: 'NOT_APPLICABLE', label: '계산 불가', reason: '월 총 분 계산 불가 또는 장애 정보 부족' };
  }
  if (sloBreached === false) {
    return { status: 'NOT_APPLICABLE', label: '해당 없음', reason: 'SLO 위반 없음 (99.90% 이상)' };
  }
  if (evidenceStatus === 'INSUFFICIENT' || evidenceStatus === 'UNDETERMINED') {
    return { status: 'NEEDS_REVIEW', label: '추가 확인 필요', reason: '증거 부족으로 청구 검토 준비 미완료' };
  }
  if (deadlineBlocker) {
    return { status: 'NEEDS_REVIEW', label: '추가 확인 필요', reason: '청구 검토 준비 미완료' };
  }
  return { status: 'READY_FOR_HUMAN_CLAIM_REVIEW', label: '청구 검토 준비 완료', reason: '청구 검토 준비 완료' };
}

// ─── 통합 분석 (Python: analyze) ────────────────────────────
function analyze(year, month, incidents, exclusions) {
  const bounds = monthBounds(year, month);

  // incident 파싱 & clip
  const clipped = [];
  let beforeUnion = 0;
  for (const it of incidents) {
    beforeUnion++;
    const s = parseRFC3339ToUTC(it.start);
    const e = parseRFC3339ToUTC(it.end);
    if (!s || !e) continue;
    const sMs = dateToUTCms(s);
    const eMs = dateToUTCms(e);
    if (sMs === null || eMs === null) continue;
    const c = clip(sMs, eMs, bounds.start, bounds.end);
    if (c) clipped.push(c);
  }

  const unionIncidents = unionIntervals(clipped);
  const afterUnion = unionIncidents.length;

  const gross = minutesWithFloorRule(unionIncidents);

  // exclusion 처리
  let excluded = 0;
  if (exclusions && exclusions.length > 0) {
    const exClipped = [];
    for (const ex of exclusions) {
      const es = parseRFC3339ToUTC(ex.start);
      const ee = parseRFC3339ToUTC(ex.end);
      if (!es || !ee) continue;
      const sMs = dateToUTCms(es);
      const eMs = dateToUTCms(ee);
      if (sMs === null || eMs === null) continue;
      const c = clip(sMs, eMs, bounds.start, bounds.end);
      if (c) exClipped.push(c);
    }
    const exUnion = unionIntervals(exClipped);
    excluded = minutesWithFloorRule(exUnion);
  }

  const eligible = Math.max(gross - excluded, 0);
  const rawMup = bounds.totalMinutes > 0 ? (bounds.totalMinutes - eligible) / bounds.totalMinutes * 100 : null;
  const displayMup = rawMup !== null ? Math.round(rawMup * 100) / 100 : null;
  const breached = rawMup !== null && rawMup < 99.9;
  const tier = calcTier(rawMup);

  return {
    year, month,
    totalMinutes: bounds.totalMinutes,
    grossOutage: gross,
    excluded,
    eligible,
    beforeUnion,
    afterUnion,
    rawMup,
    displayMup,
    breached,
    tier,
  };
}

// ─── 입력에서 분석 실행 (screen_a → screen_b 연결용) ─────────
function computeFromInput(input) {
  if (!input || !input.incidents) {
    return { error: '입력 데이터가 없습니다.' };
  }

  const year = input.year;
  const month = input.month;
  const bounds = monthBounds(year, month);

  // incident 파싱 & clip
  const clipped = [];
  let beforeUnion = 0;
  let parseErrors = 0;
  for (const it of input.incidents) {
    beforeUnion++;
    const s = parseRFC3339ToUTC(it.start);
    const e = parseRFC3339ToUTC(it.end);
    if (!s || !e) { parseErrors++; continue; }
    const sMs = dateToUTCms(s);
    const eMs = dateToUTCms(e);
    if (sMs === null || eMs === null) continue;
    const c = clip(sMs, eMs, bounds.start, bounds.end);
    if (c) clipped.push(c);
  }

  // clip 안 된 incident가 있으면 범위 밖
  if (clipped.length === 0 && input.incidents.length > 0) {
    return {
      error: ' 입력한 장애 구간이 분석 대상 월 범위를 벗어났거나 형식이 맞지 않습니다.',
      monthLabel: year + '-' + String(month).padStart(2, '0'),
      totalMinutes: bounds.totalMinutes,
      beforeUnion: input.incidents.length,
      afterUnion: 0,
    };
  }

  const unionIncidents = unionIntervals(clipped);
  const afterUnion = unionIncidents.length;

  const gross = minutesWithFloorRule(unionIncidents);

  const excluded = 0;
  const eligible = Math.max(gross - excluded, 0);
  const rawMup = bounds.totalMinutes > 0 ? (bounds.totalMinutes - eligible) / bounds.totalMinutes * 100 : null;
  const displayMup = rawMup !== null ? Math.round(rawMup * 100) / 100 : null;
  const breached = rawMup !== null && rawMup < 99.9;
  const tier = calcTier(rawMup);

  const evidenceStatus = input.evidence_status || 'UNDETERMINED';
  const readiness = calcReadiness(breached, evidenceStatus, input.billing_verified || false, input.deadline_blocker || false);

  return {
    monthLabel: year + '-' + String(month).padStart(2, '0'),
    totalMinutes: bounds.totalMinutes,
    grossOutage: gross,
    excluded,
    eligible,
    beforeUnion: input.incidents.length,
    afterUnion,
    rawMup,
    displayMup,
    breached,
    tier,
    readiness,
    incidents: unionIncidents,
    parseErrors,
    error: null,
  };
}

// ─── Scenario 정의 ────────────────────────────────────────────
const SCENARIO_A = {
  year: 2025, month: 7,
  incidents: [
    { start: '2025-07-10T08:00:00Z', end: '2025-07-10T08:35:00Z' },
    { start: '2025-07-15T12:00:00Z', end: '2025-07-15T12:20:00Z' },
  ],
  logs: 'Cloud Logging excerpt showing external connectivity loss at outage start/end',
  extract: {
    project_id: 'my-sla-recovery-project',
    instance_id: '1234567890123456789',
    nic: 'nic0',
    network_tier: 'Premium',
    series: 'E2',
    provisioning: 'standard',
    region: 'us-central1',
    outage_type: 'external connectivity loss',
  },
  evidence_status: 'SUFFICIENT',
  billing_verified: false,
  deadline_blocker: false,
  case_id: 'support-case-12345',
  google_incident_link: 'https://status.cloud.google.com/incidents/sample',
};

const SCENARIO_B = {
  year: 2025, month: 7,
  incidents: [
    { start: '2025-07-10T08:00:00Z', end: '2025-07-10T08:44:00Z' },
  ],
  logs: 'Cloud Logging excerpt',
  extract: {
    project_id: 'my-sla-recovery-project',
    instance_id: '1234567890123456789',
    nic: 'nic0',
    network_tier: 'Premium',
    series: 'E2',
    provisioning: 'standard',
    region: 'us-central1',
    outage_type: 'external connectivity loss',
  },
  evidence_status: 'SUFFICIENT',
  billing_verified: false,
  deadline_blocker: false,
  case_id: 'support-case-12345',
  google_incident_link: 'https://status.cloud.google.com/incidents/sample',
};

const SCENARIO_C = {
  year: 2025, month: 7,
  incidents: [
    { start: '2025-07-10T08:00:00Z', end: '2025-07-10T08:35:00Z' },
    { start: '2025-07-15T12:00:00Z', end: '2025-07-15T12:20:00Z' },
  ],
  logs: '',
  extract: {
    project_id: 'my-sla-recovery-project',
    instance_id: '1234567890123456789',
    nic: 'nic0',
    network_tier: 'Premium',
    series: 'E2',
    provisioning: 'standard',
    region: 'us-central1',
    outage_type: 'external connectivity loss',
  },
  evidence_status: 'INSUFFICIENT',
  billing_verified: false,
  deadline_blocker: false,
  case_id: '',
  google_incident_link: '',
};

// ─── 유틸리티 ────────────────────────────────────────────────
function esc(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function msToRFC3339(ms) {
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}Z`;
}

// 테스트용: 시나리오 A/B/C 계산 결과 console 출력
function testScenarios() {
  console.log('=== Scenario A ===');
  const rA = computeFromInput(SCENARIO_A);
  console.log('MUP raw:', rA.rawMup, 'display:', rA.displayMup, 'breached:', rA.breached, 'tier:', rA.tier);
  console.log('readiness:', rA.readiness);

  console.log('=== Scenario B ===');
  const rB = computeFromInput(SCENARIO_B);
  console.log('MUP raw:', rB.rawMup, 'display:', rB.displayMup, 'breached:', rB.breached, 'tier:', rB.tier);
  console.log('readiness:', rB.readiness);

  console.log('=== Scenario C ===');
  const rC = computeFromInput(SCENARIO_C);
  console.log('MUP raw:', rC.rawMup, 'display:', rC.displayMup, 'breached:', rC.breached, 'tier:', rC.tier);
  console.log('readiness:', rC.readiness);

  console.log('=== Out of scope test (월 범위 밖) ===');
  const outOfScope = computeFromInput({
    year: 2025, month: 7,
    incidents: [{ start: '2025-08-10T08:00:00Z', end: '2025-08-10T08:35:00Z' }],
    evidence_status: 'SUFFICIENT',
  });
  console.log('error:', outOfScope.error, 'afterUnion:', outOfScope.afterUnion);
}

// 테스트 실행 (개발 시만)
if (typeof window !== 'undefined' && window.__SLA_DEBUG__) {
  testScenarios();
}
