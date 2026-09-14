const { getBearerToken, assertProjectId, assertClosedMonth, google, tail, scopeAssessment, sendError } = require('./_shared');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST만 지원합니다.' });
  try {
    const token = getBearerToken(req);
    const { projectId, month } = req.body || {};
    assertProjectId(projectId); assertClosedMonth(month);
    let pageToken = ''; const instances = [];
    do {
      const query = new URLSearchParams({ maxResults: '500', returnPartialSuccess: 'true' });
      if (pageToken) query.set('pageToken', pageToken);
      const data = await google(token, `https://compute.googleapis.com/compute/v1/projects/${encodeURIComponent(projectId)}/aggregated/instances?${query}`);
      for (const [scope, value] of Object.entries(data.items || {})) {
        for (const vm of value.instances || []) {
          const item = {
            id: String(vm.id), name: vm.name, zone: tail(vm.zone || scope), status: vm.status,
            machineSeries: tail(vm.machineType), networkInterfaceCount: (vm.networkInterfaces || []).length,
            networkTiers: [...new Set((vm.networkInterfaces || []).flatMap(nic => (nic.accessConfigs || []).map(access => access.networkTier).filter(Boolean)))],
            scheduling: { preemptible: Boolean(vm.scheduling?.preemptible), provisioningModel: vm.scheduling?.provisioningModel || 'STANDARD' },
          };
          item.scopeAssessment = scopeAssessment(item); instances.push(item);
        }
      }
      pageToken = data.nextPageToken || '';
    } while (pageToken);
    res.status(200).json({ executionStatus: 'COMPLETE', source: 'gcp-api', projectId, month, instances, caution: '인스턴스 정보는 자동 수집했습니다. 장애 구간과 external connectivity loss 증거는 다음 단계에서 사람이 확인해야 합니다.' });
  } catch (error) { sendError(res, error); }
};
