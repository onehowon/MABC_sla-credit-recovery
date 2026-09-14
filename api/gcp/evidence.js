const { getBearerToken, assertProjectId, google, sendError } = require('./_shared');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST만 지원합니다.' });
  try {
    const token = getBearerToken(req);
    const { projectId, instanceId, start, end } = req.body || {};
    assertProjectId(projectId);
    if (!/^\d+$/.test(String(instanceId || ''))) throw Object.assign(new Error('numeric instance ID가 필요합니다.'), { statusCode: 400 });
    const startAt = new Date(start), endAt = new Date(end);
    if (Number.isNaN(startAt.getTime()) || Number.isNaN(endAt.getTime()) || endAt <= startAt) throw Object.assign(new Error('올바른 장애 시작·종료 시각이 필요합니다.'), { statusCode: 400 });
    const filter = ['resource.type="gce_instance"', `resource.labels.instance_id="${instanceId}"`, `timestamp >= "${startAt.toISOString()}"`, `timestamp < "${endAt.toISOString()}"`].join('\n');
    const data = await google(token, 'https://logging.googleapis.com/v2/entries:list', { method: 'POST', body: JSON.stringify({ resourceNames: [`projects/${projectId}`], filter, orderBy: 'timestamp asc', pageSize: 100 }) });
    const entries = (data.entries || []).map(entry => ({ timestamp: entry.timestamp, logName: entry.logName, severity: entry.severity, message: String(entry.textPayload || entry.jsonPayload?.message || '').replace(/\s+/g, ' ').slice(0, 500) }));
    res.status(200).json({ source: 'gcp-api', queriedRange: { start: startAt.toISOString(), end: endAt.toISOString() }, entries, evidenceStatus: entries.length ? 'CANDIDATE_FOUND' : 'NO_CANDIDATE_FOUND', caution: '조회된 로그는 증거 후보입니다. external connectivity loss 및 장애 시각을 사람이 검토한 뒤에만 SLA 계산에 반영하세요.' });
  } catch (error) { sendError(res, error); }
};
