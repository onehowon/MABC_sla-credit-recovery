# Read-only GCP MCP server

`gcp-readonly-server.mjs`는 SLA Recovery Agent가 GCP 리소스와 Cloud Logging의 **증거 후보**를 가져오기 위한 로컬 MCP 서버입니다.

- Compute Engine 인스턴스 목록 조회만 수행합니다.
- 지정 instance/time range의 Cloud Logging만 조회합니다.
- GCP 리소스를 생성·변경·삭제하지 않습니다.
- SLA 위반, provider 귀책, Financial Credit 승인, 실제 claim 제출을 자동 확정하거나 수행하지 않습니다.

## 사전 조건

1. Google Cloud CLI를 설치합니다.
2. 사용자 계정으로 Application Default Credentials를 설정합니다.

```bash
gcloud auth application-default login
```

3. 대상 프로젝트에서 최소 읽기 권한을 부여합니다.

   - Compute Engine Viewer
   - Logs Viewer

   Monitoring 데이터까지 확장할 경우 Monitoring Viewer도 추가합니다.

## Codex MCP 등록 예시

Codex의 MCP 설정에 아래처럼 등록합니다. 절대 서비스 계정 키 파일이나 access token을 저장소에 넣지 않습니다.

```json
{
  "mcpServers": {
    "sla-gcp-readonly": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/MABC_sla-credit-recovery/mcp/gcp-readonly-server.mjs"]
    }
  }
}
```

## 권장 작업 순서

1. `gcp_discover_sla_month_context`로 닫힌 월의 GCE 인벤토리를 조회합니다.
2. single NIC / Premium / E2 / standard provisioning 범위 후보를 사람이 확인합니다.
3. 한 instance와 사용자가 확인한 장애 구간에 대해 `gcp_find_connectivity_evidence`를 호출합니다.
4. 로그 결과는 증거 후보로만 취급하고, `sla-credit-recovery` 스킬의 scope/evidence gate와 Frozen 계산기에 전달합니다.

GCP API는 실제 리소스와 로그를 읽는 수단입니다. SLA 규칙 판정은 이 MCP 서버가 아니라 `sla-credit-recovery` 스킬의 결정론적 계산 파이프라인이 수행합니다.
