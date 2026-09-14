function getBearerToken(req) {
  const header = req.headers.authorization || '';
  if (!header.startsWith('Bearer ')) throw Object.assign(new Error('Google 연결 권한이 없습니다. 다시 연결해 주세요.'), { statusCode: 401 });
  return header.slice('Bearer '.length);
}
function assertProjectId(projectId) {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId || '')) throw Object.assign(new Error('유효한 GCP project ID를 입력하세요.'), { statusCode: 400 });
}
function assertClosedMonth(month) {
  if (!/^\d{4}-\d{2}$/.test(month || '')) throw Object.assign(new Error('대상 월은 YYYY-MM 형식이어야 합니다.'), { statusCode: 400 });
  const [year, monthNumber] = month.split('-').map(Number);
  const end = new Date(Date.UTC(year, monthNumber, 1));
  const currentStart = new Date();
  currentStart.setUTCDate(1); currentStart.setUTCHours(0, 0, 0, 0);
  if (end > currentStart) throw Object.assign(new Error('v1은 이미 종료된 calendar month만 분석합니다.'), { statusCode: 400 });
}
async function google(token, url, options = {}) {
  const response = await fetch(url, { ...options, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) } });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(json?.error?.message || `Google API 요청 실패 (${response.status})`), { statusCode: response.status });
  return json;
}
function tail(value = '') { return String(value).split('/').pop(); }
function scopeAssessment(instance) {
  const reasons = [];
  if (!String(instance.machineSeries || '').toUpperCase().startsWith('E2-')) reasons.push('E2 machine series가 아닙니다.');
  if (instance.networkInterfaceCount !== 1) reasons.push('v1은 단일 NIC만 지원합니다.');
  if (instance.scheduling.preemptible || instance.scheduling.provisioningModel === 'SPOT') reasons.push('Spot/Preemptible VM은 v1 대상이 아닙니다.');
  if (instance.networkTiers.length !== 1 || instance.networkTiers[0] !== 'PREMIUM') reasons.push('Premium tier를 단일하게 확인할 수 없습니다.');
  return { executionStatus: reasons.length ? 'OUT_OF_SCOPE' : 'COMPLETE', scope: reasons.length ? 'OUT_OF_SCOPE' : 'IN_SCOPE_CANDIDATE', reasons };
}
function sendError(res, error) { res.status(error.statusCode || 500).json({ error: error.message || '요청 처리 중 오류가 발생했습니다.' }); }
module.exports = { getBearerToken, assertProjectId, assertClosedMonth, google, tail, scopeAssessment, sendError };
