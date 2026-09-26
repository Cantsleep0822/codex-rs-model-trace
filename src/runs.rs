//! 检测运行的持久化记录：写入 `host.state` 命名空间 `trace`，
//! 页面管理调用与执行步骤共享同一份状态，重启后仍可查看结果。

use gateway_plugin_sdk::{
    ErrorCode, PluginFault,
    call::host::StateDeleteRequest,
    client::{HostClient, SessionError},
};
use serde::{Deserialize, Serialize};

use crate::model::GenerateOutcome;

pub const NAMESPACE: &str = "trace";
pub const INDEX_KEY: &str = "runs-index";
/// 管理页设置：挑战数量与历史展示条数，随实例状态持久化。
pub const SETTINGS_KEY: &str = "ui-settings";
/// 保留在索引中的最近运行数；运行正文仍单独按键保存。
pub const MAX_INDEX_ENTRIES: usize = 24;
/// 每道挑战允许的最大尝试次数；超出即判定本次测试失败。
pub const MAX_ATTEMPTS: u32 = 4;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunIndexEntry {
    pub id: String,
    pub model: String,
    #[serde(default)]
    pub client_key_name: Option<String>,
    pub account_id: Option<String>,
    pub account_name: Option<String>,
    pub status: String,
    pub created_at_ms: i64,
    pub prediction: Option<String>,
    pub probability: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttemptRecord {
    pub index: u32,
    pub status: String,
    pub parsed_numbers: Option<usize>,
    pub minimum_numbers: Option<usize>,
    pub finish_reason: Option<String>,
    pub upstream_model: Option<String>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub error: Option<String>,
    pub text_preview: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueryState {
    pub index: u32,
    pub prompt: String,
    pub expected_count: u32,
    pub status: String,
    pub attempts: Vec<AttemptRecord>,
    /// 最近一次有效回答的完整数字序列；归因在页面本地完成。
    pub numbers: Option<Vec<u32>>,
    pub response: Option<GenerateOutcome>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunState {
    pub id: String,
    pub status: String,
    pub model: String,
    pub client_key_id: String,
    #[serde(default)]
    pub client_key_name: Option<String>,
    pub account_id: Option<String>,
    pub provider: Option<String>,
    pub account_name: Option<String>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub completed_at_ms: Option<i64>,
    pub cancel_requested: bool,
    pub queries: Vec<QueryState>,
    /// 页面本地归因回写的结果摘要。
    pub result: Option<serde_json::Value>,
}

impl RunState {
    /// 页面展示视图：数字序列保留供本地归因；仅剥离回答原文（尝试里已有短预览）。
    pub fn view(&self) -> serde_json::Value {
        let mut value = serde_json::to_value(self).unwrap_or_default();
        if let Some(queries) = value
            .get_mut("queries")
            .and_then(serde_json::Value::as_array_mut)
        {
            for query in queries {
                if let Some(response) = query.get_mut("response")
                    && let Some(text) = response.get_mut("text")
                {
                    *text = serde_json::json!("");
                }
            }
        }
        value
    }

    /// 索引投影；终态与结果字段同步进历史列表。
    pub fn index_entry(&self) -> RunIndexEntry {
        RunIndexEntry {
            id: self.id.clone(),
            model: self.model.clone(),
            client_key_name: self.client_key_name.clone(),
            account_id: self.account_id.clone(),
            account_name: self.account_name.clone(),
            status: self.status.clone(),
            created_at_ms: self.created_at_ms,
            prediction: self
                .result
                .as_ref()
                .and_then(|value| value.get("prediction"))
                .and_then(|value| value.as_str().map(str::to_owned)),
            probability: self
                .result
                .as_ref()
                .and_then(|value| value.get("probability"))
                .and_then(serde_json::Value::as_f64),
        }
    }
}

fn state_key(run_id: &str) -> String {
    format!("run-{run_id}")
}

fn session_fault(error: SessionError) -> PluginFault {
    error.into_plugin_fault()
}

fn encode_fault() -> PluginFault {
    PluginFault::new(ErrorCode::Fault, "state payload encode failed")
}

pub(crate) async fn get_value(
    host: &HostClient,
    key: &str,
) -> Result<Option<(serde_json::Value, u64)>, PluginFault> {
    let reply = host
        .call(
            "host.state.get",
            serde_json::json!({"namespace": NAMESPACE, "key": key}),
            Vec::new(),
        )
        .await
        .map_err(session_fault)?;
    let record = reply.result.get("record").cloned().unwrap_or_default();
    if record.is_null() {
        return Ok(None);
    }
    let version = record
        .get("version")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    Ok(Some((
        record.get("value").cloned().unwrap_or_default(),
        version,
    )))
}

pub(crate) async fn put_value(
    host: &HostClient,
    key: &str,
    value: serde_json::Value,
    expected_version: Option<u64>,
) -> Result<u64, PluginFault> {
    let reply = host
        .call(
            "host.state.put",
            serde_json::json!({
                "namespace": NAMESPACE,
                "key": key,
                "value": value,
                "expected_version": expected_version,
            }),
            Vec::new(),
        )
        .await
        .map_err(session_fault)?;
    reply
        .result
        .get("version")
        .and_then(serde_json::Value::as_u64)
        .ok_or_else(encode_fault)
}

/// 读取运行索引；损坏时按空索引处理，不阻塞新测试。
/// 命名空间 schema 只接受 object，索引包在 `entries` 字段里。
pub async fn load_index(host: &HostClient) -> Vec<RunIndexEntry> {
    let Ok(Some((value, _))) = get_value(host, INDEX_KEY).await else {
        return Vec::new();
    };
    value
        .get("entries")
        .cloned()
        .and_then(|entries| serde_json::from_value(entries).ok())
        .unwrap_or_default()
}

/// 保存完整索引；调用方负责裁剪长度。
pub async fn save_index_entries(
    host: &HostClient,
    entries: &[RunIndexEntry],
) -> Result<(), PluginFault> {
    let (_, version) = get_value(host, INDEX_KEY).await?.unwrap_or_default();
    put_value(
        host,
        INDEX_KEY,
        serde_json::json!({"entries": entries}),
        (version != 0).then_some(version),
    )
    .await?;
    Ok(())
}

/// 追加/更新一条索引，失败不阻断运行（仅索引展示受影响）。
/// 被裁掉的运行记录一并删除，避免长期累积超过命名空间记录上限。
pub async fn touch_index(host: &HostClient, entry: RunIndexEntry) {
    let mut entries = load_index(host).await;
    entries.retain(|item| item.id != entry.id);
    entries.insert(0, entry);
    let evicted = entries.split_off(entries.len().min(MAX_INDEX_ENTRIES));
    if save_index_entries(host, &entries).await.is_err() {
        return;
    }
    for entry in evicted {
        delete_run_record(host, &entry.id).await;
    }
}

/// 按当前版本删除一条运行记录；记录缺失或版本冲突时静默跳过。
async fn delete_run_record(host: &HostClient, id: &str) {
    let key = state_key(id);
    let Ok(Some((_, version))) = get_value(host, &key).await else {
        return;
    };
    let Ok(params) = serde_json::to_value(StateDeleteRequest {
        namespace: NAMESPACE.to_owned(),
        key,
        expected_version: version,
    }) else {
        return;
    };
    let _ = host.call("host.state.delete", params, Vec::new()).await;
}

pub async fn load_run(host: &HostClient, id: &str) -> Result<Option<(RunState, u64)>, PluginFault> {
    let Some((value, version)) = get_value(host, &state_key(id)).await? else {
        return Ok(None);
    };
    match serde_json::from_value::<RunState>(value) {
        Ok(run) => Ok(Some((run, version))),
        Err(_) => Ok(None),
    }
}

pub async fn save_run(
    host: &HostClient,
    run: &RunState,
    expected_version: Option<u64>,
) -> Result<u64, PluginFault> {
    put_value(
        host,
        &state_key(&run.id),
        serde_json::to_value(run).map_err(|_| encode_fault())?,
        expected_version,
    )
    .await
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default()
}
