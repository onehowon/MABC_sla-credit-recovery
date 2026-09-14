#!/usr/bin/env node
/**
 * SLA Recovery Agent — read-only Google Cloud MCP server.
 *
 * It deliberately never creates, changes, deletes, or submits anything in GCP.
 * It only collects resource metadata and candidate Cloud Logging evidence; the
 * frozen SLA calculator remains the sole component that decides eligibility.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import readline from 'node:readline';

const execFileAsync = promisify(execFile);
const MAX_LOG_ENTRIES = 100;

function response(id, result) { return { jsonrpc: '2.0', id, result }; }
function failure(id, message, data) {
  return { jsonrpc: '2.0', id, error: { code: -32000, message, data } };
}
function write(message) { process.stdout.write(JSON.stringify(message) + '\n'); }

async function accessToken() {
  try {
    const { stdout } = await execFileAsync('gcloud', ['auth', 'application-default', 'print-access-token'], { timeout: 15_000 });
    const token = stdout.trim();
    if (!token) throw new Error('빈 access token이 반환됐습니다.');
    return token;
  } catch (error) {
    throw new Error('Google Application Default Credentials를 읽지 못했습니다. `gcloud auth application-default login`을 실행하고 Compute Engine API 및 Cloud Logging API 접근 권한을 확인하세요. 원인: ' + error.message);
  }
}

async function google(url, options = {}) {
  const token = await accessToken();
  const res = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google API ${res.status}: ${body?.error?.message || '요청 실패'}`);
  return body;
}

function assertProject(projectId) {
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId || '')) {
    throw new Error('유효한 GCP project ID를 입력하세요.');
  }
}
function isoStartOfMonth(month) {
  if (!/^\d{4}-\d{2}$/.test(month || '')) throw new Error('month는 YYYY-MM 형식이어야 합니다.');
  return `${month}-01T00:00:00Z`;
}
function isoStartOfNextMonth(month) {
  const [year, value] = month.split('-').map(Number);
  return new Date(Date.UTC(year, value, 1)).toISOString().replace('.000Z', 'Z');
}
function tail(value = '') { return String(value).split('/').pop(); }
function safeText(entry) {
  const text = entry.textPayload || entry.jsonPayload?.message || entry.protoPayload?.status?.message || '';
  return String(text).replace(/\s+/g, ' ').slice(0, 500);
}

async function listInstances({ projectId }) {
  assertProject(projectId);
  let pageToken = '';
  const instances = [];
  do {
    const query = new URLSearchParams({ maxResults: '500', returnPartialSuccess: 'true' });
    if (pageToken) query.set('pageToken', pageToken);
    const data = await google(`https://compute.googleapis.com/compute/v1/projects/${encodeURIComponent(projectId)}/aggregated/instances?${query}`);
    for (const [scope, scoped] of Object.entries(data.items || {})) {
      for (const instance of scoped.instances || []) {
        instances.push({
          id: instance.id,
          name: instance.name,
          zone: tail(instance.zone || scope),
          status: instance.status,
          machineSeries: tail(instance.machineType),
          networkInterfaceCount: (instance.networkInterfaces || []).length,
          networkTiers: [...new Set((instance.networkInterfaces || []).flatMap(nic => (nic.accessConfigs || []).map(ac => ac.networkTier).filter(Boolean)))],
          scheduling: { preemptible: Boolean(instance.scheduling?.preemptible), provisioningModel: instance.scheduling?.provisioningModel || 'STANDARD' },
        });
      }
    }
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return { projectId, fetchedAt: new Date().toISOString(), instances };
}

async function findConnectivityEvidence({ projectId, instanceId, start, end, pageSize = 50 }) {
  assertProject(projectId);
  if (!/^\d+$/.test(String(instanceId || ''))) throw new Error('instanceId는 Compute Engine numeric instance ID여야 합니다.');
  const startDate = new Date(start), endDate = new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime()) || endDate <= startDate) throw new Error('start/end에는 올바른 RFC3339 시간이 필요합니다.');
  const limit = Math.max(1, Math.min(Number(pageSize) || 50, MAX_LOG_ENTRIES));
  const filter = [
    'resource.type="gce_instance"',
    `resource.labels.instance_id="${String(instanceId)}"`,
    `timestamp >= "${startDate.toISOString()}"`,
    `timestamp < "${endDate.toISOString()}"`,
  ].join('\n');
  const data = await google('https://logging.googleapis.com/v2/entries:list', {
    method: 'POST',
    body: JSON.stringify({ resourceNames: [`projects/${projectId}`], filter, orderBy: 'timestamp asc', pageSize: limit }),
  });
  return {
    projectId, instanceId: String(instanceId), queriedRange: { start: startDate.toISOString(), end: endDate.toISOString() }, filter,
    entries: (data.entries || []).map(entry => ({ timestamp: entry.timestamp, logName: entry.logName, insertId: entry.insertId, severity: entry.severity, message: safeText(entry) })),
    nextPageToken: data.nextPageToken || null,
    caution: '이 결과는 증거 후보입니다. external connectivity loss와 장애 시작·종료 시각을 사람이 확인해야 하며, 자동으로 SLA 적격 장애로 확정하지 않습니다.',
  };
}

async function discoverMonthContext({ projectId, month }) {
  assertProject(projectId);
  const inventory = await listInstances({ projectId });
  return {
    ...inventory,
    month,
    queriedRange: { start: isoStartOfMonth(month), end: isoStartOfNextMonth(month) },
    nextStep: '대상 인스턴스를 하나 선택한 뒤 gcp_find_connectivity_evidence로 장애 후보 구간의 로그를 확인하세요. 로그만으로 적격 장애나 Google 귀책을 자동 확정하지 않습니다.',
  };
}

const tools = [
  { name: 'gcp_list_gce_instances', description: '프로젝트의 GCE 인스턴스를 읽기 전용으로 조회한다. SLA v1 scope 후보(E2, Premium, single NIC)를 사람이 고를 수 있도록 메타데이터만 반환한다.', inputSchema: { type: 'object', properties: { projectId: { type: 'string', description: 'GCP project ID' } }, required: ['projectId'], additionalProperties: false } },
  { name: 'gcp_find_connectivity_evidence', description: '선택한 GCE numeric instance ID와 시간 범위로 Cloud Logging 증거 후보를 읽기 전용으로 조회한다. 결과는 SLA 적격 장애의 자동 확정이 아니다.', inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, instanceId: { type: 'string' }, start: { type: 'string', description: 'RFC3339' }, end: { type: 'string', description: 'RFC3339' }, pageSize: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['projectId', 'instanceId', 'start', 'end'], additionalProperties: false } },
  { name: 'gcp_discover_sla_month_context', description: '닫힌 calendar month와 프로젝트를 받아 GCE 인벤토리 및 다음 증거 수집 범위를 반환한다. 청구 가능 여부나 금액은 판정하지 않는다.', inputSchema: { type: 'object', properties: { projectId: { type: 'string' }, month: { type: 'string', description: 'YYYY-MM, closed calendar month' } }, required: ['projectId', 'month'], additionalProperties: false } },
];

async function callTool(name, args) {
  if (name === 'gcp_list_gce_instances') return listInstances(args);
  if (name === 'gcp_find_connectivity_evidence') return findConnectivityEvidence(args);
  if (name === 'gcp_discover_sla_month_context') return discoverMonthContext(args);
  throw new Error(`알 수 없는 도구: ${name}`);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', async line => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  try {
    if (message.method === 'initialize') return write(response(message.id, { protocolVersion: message.params?.protocolVersion || '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'sla-gcp-readonly', version: '0.1.0' } }));
    if (message.method === 'tools/list') return write(response(message.id, { tools }));
    if (message.method === 'tools/call') {
      const result = await callTool(message.params?.name, message.params?.arguments || {});
      return write(response(message.id, { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], structuredContent: result }));
    }
    if (message.id !== undefined) return write(failure(message.id, `지원하지 않는 method: ${message.method}`));
  } catch (error) {
    if (message.id !== undefined) write(failure(message.id, error.message));
  }
});
