//! 管理页设置：挑战数量与历史展示条数，持久化在 `trace` 命名空间的
//! `ui-settings` 记录中；页面每次加载先读设置再渲染表单与历史。

use gateway_plugin_sdk::{call::host::StateDeleteRequest, client::HostClient};
use serde_json::{Value, json};

use crate::runs;
use crate::{ManagementCall, ManagementResult, decode_body, json_response};

/// 允许的挑战条数上限：与后端 `MAX_QUERIES` 及指纹归因输入一致。
pub const DEFAULT_CHALLENGE_COUNT: u32 = 3;
pub const DEFAULT_HISTORY_LIMIT: usize = 24;
const MIN_CHALLENGE_COUNT: u32 = 1;
const MAX_CHALLENGE_COUNT: u32 = 3;
const MIN_HISTORY_LIMIT: usize = 4;
const MAX_HISTORY_LIMIT: usize = 64;

/// 当前生效设置；历史展示条数仅影响渲染，不改命名空间保存上限。
/// `default_effort` 允许 low|medium|high|xhigh|max，非法值按未设置处理。
fn normalize(settings: &Value) -> (u32, usize, Option<String>) {
    let challenge_count = settings
        .get("challenge_count")
        .and_then(Value::as_u64)
        .map(|value| value as u32)
        .unwrap_or(DEFAULT_CHALLENGE_COUNT)
        .clamp(MIN_CHALLENGE_COUNT, MAX_CHALLENGE_COUNT);
    let history_limit = settings
        .get("history_limit")
        .and_then(Value::as_u64)
        .map(|value| value as usize)
        .unwrap_or(DEFAULT_HISTORY_LIMIT)
        .clamp(MIN_HISTORY_LIMIT, MAX_HISTORY_LIMIT);
    let default_effort = settings
        .get("default_effort")
        .and_then(Value::as_str)
        .filter(|effort| ["low", "medium", "high", "xhigh", "max"].contains(effort))
        .map(str::to_owned);
    (challenge_count, history_limit, default_effort)
}

fn settings_json(settings: &Value) -> Value {
    let (challenge_count, history_limit, default_effort) = normalize(settings);
    json!({
        "challenge_count": challenge_count,
        "history_limit": history_limit,
        "default_effort": default_effort,
    })
}

pub async fn load(host: &HostClient) -> ManagementResult {
    let stored = match runs::get_value(host, runs::SETTINGS_KEY).await {
        Ok(found) => found.map(|(value, _)| value).unwrap_or_default(),
        Err(error) => return json_response(500, json!({ "error": error.message })),
    };
    json_response(200, json!({ "settings": settings_json(&stored) }))
}

/// 只接受白名单字段；未知键忽略，避免页面把展示态写进持久设置。
pub async fn save(call: &ManagementCall) -> ManagementResult {
    let body: Value = match decode_body(call) {
        Ok(body) => body,
        Err(error) => return json_response(400, json!({ "error": error.message })),
    };
    let mut stored = match runs::get_value(&call.host, runs::SETTINGS_KEY).await {
        Ok(found) => found,
        Err(error) => return json_response(500, json!({ "error": error.message })),
    };
    let (current, version) = stored
        .take()
        .map(|(value, version)| (value, Some(version)))
        .unwrap_or((json!({}), None));
    let mut merged = current;
    for key in ["challenge_count", "history_limit", "default_effort"] {
        if let Some(value) = body.get(key)
            && !value.is_null()
        {
            merged[key] = value.clone();
        }
    }
    let normalized = settings_json(&merged);
    match runs::put_value(&call.host, runs::SETTINGS_KEY, normalized.clone(), version).await {
        Ok(_) => json_response(200, json!({ "settings": normalized })),
        Err(error) => json_response(500, json!({ "error": error.message })),
    }
}

/// 恢复默认：删除持久设置记录；记录不存在时视为成功。
pub async fn reset(host: &HostClient) -> ManagementResult {
    let found = match runs::get_value(host, runs::SETTINGS_KEY).await {
        Ok(found) => found,
        Err(error) => return json_response(500, json!({ "error": error.message })),
    };
    if let Some((_, version)) = found {
        let params = match serde_json::to_value(StateDeleteRequest {
            namespace: runs::NAMESPACE.to_owned(),
            key: runs::SETTINGS_KEY.to_owned(),
            expected_version: version,
        }) {
            Ok(params) => params,
            Err(_) => return json_response(500, json!({ "error": "state payload encode failed" })),
        };
        if let Err(error) = host.call("host.state.delete", params, Vec::new()).await {
            return json_response(500, json!({ "error": error.into_plugin_fault().message }));
        }
    }
    json_response(
        200,
        json!({
            "settings": {
                "challenge_count": DEFAULT_CHALLENGE_COUNT,
                "history_limit": DEFAULT_HISTORY_LIMIT,
                "default_effort": null,
            }
        }),
    )
}
