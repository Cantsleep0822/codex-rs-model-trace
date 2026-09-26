//! 宿主模型与数据回调的轻量封装；全部通过 `HostClient` 走已授权回调，不直连上游。

use gateway_plugin_sdk::{
    ErrorCode, PluginFault,
    call::{
        host::{
            AuthListRequest, AuthListResult, KeyListRequest, KeyListResult, ModelEventBatch,
            ModelExecuteRequest, ModelExecuteResult, ModelListRequest, ModelListResult,
            ModelOperation,
        },
        model::{CanonicalEvent, FinishReason},
    },
    client::{HostClient, SessionError},
};
use serde::Serialize;
use serde_json::Value;

/// 页面选择上游账号需要名称等投影信息；凭据明细永远不在此处读取。
#[derive(Debug, Clone)]
pub struct AccountOption {
    pub account_id: String,
    pub provider_id: String,
    pub name: String,
    pub enabled: bool,
}

#[derive(Debug, Clone)]
pub struct KeyOption {
    pub id: String,
    pub name: String,
    pub enabled: bool,
}

/// 一次模型调用的可展示结果。
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct GenerateOutcome {
    pub text: String,
    pub model: Option<String>,
    pub response_id: Option<String>,
    pub finish_reason: Option<String>,
    pub input_tokens: Option<u64>,
    pub output_tokens: Option<u64>,
    pub reasoning_tokens: Option<u64>,
}

fn session_fault(error: SessionError) -> PluginFault {
    error.into_plugin_fault()
}

fn encode(value: &impl Serialize) -> Result<Vec<u8>, PluginFault> {
    serde_json::to_vec(value)
        .map_err(|_| PluginFault::new(ErrorCode::Fault, "callback payload encode failed"))
}

fn encode_params(value: &impl Serialize) -> Result<Value, PluginFault> {
    serde_json::to_value(value)
        .map_err(|_| PluginFault::new(ErrorCode::Fault, "callback params encode failed"))
}

fn invalid_result() -> PluginFault {
    PluginFault::new(ErrorCode::Fault, "callback reply is invalid")
}

/// 读取全部上游账号投影（分页合并）。需要 `accounts` 权限，但只取投影字段。
pub async fn list_accounts(host: &HostClient) -> Result<Vec<AccountOption>, PluginFault> {
    let mut cursor = None;
    let mut accounts = Vec::new();
    loop {
        let request = AuthListRequest {
            provider_id: None,
            cursor: cursor.clone(),
            limit: 200,
        };
        let reply = host
            .call("host.auth.list", serde_json::json!({}), encode(&request)?)
            .await
            .map_err(session_fault)?;
        let page: AuthListResult =
            serde_json::from_slice(&reply.payload).map_err(|_| invalid_result())?;
        for account in page.accounts {
            accounts.push(AccountOption {
                account_id: account.account_id,
                provider_id: account.provider_id,
                name: account.name,
                enabled: account.enabled,
            });
        }
        match page.next_cursor {
            Some(next) => cursor = Some(next),
            None => return Ok(accounts),
        }
    }
}

/// 管理端 Key 候选；只含非秘密信息。
pub async fn list_keys(host: &HostClient) -> Result<Vec<KeyOption>, PluginFault> {
    let request = KeyListRequest {
        cursor: None,
        limit: 200,
    };
    // host.keys.list 的查询在 params 中传递，payload 必须为空。
    let reply = host
        .call("host.keys.list", encode_params(&request)?, Vec::new())
        .await
        .map_err(session_fault)?;
    let result: KeyListResult =
        serde_json::from_value(reply.result).map_err(|_| invalid_result())?;
    Ok(result
        .keys
        .into_iter()
        .map(|key| KeyOption {
            id: key.id,
            name: key.name,
            enabled: key.enabled,
        })
        .collect())
}

/// 以指定 Key 查询其可见模型目录；协议与 `generate` 执行请求一致（openai）。
/// `codex` 协议走的是 Codex 客户端目录合同，执行协议不匹配会导致目录为空。
pub async fn list_models(
    host: &HostClient,
    client_key_id: &str,
) -> Result<Vec<String>, PluginFault> {
    let request = ModelListRequest {
        client_key_id: client_key_id.to_owned(),
        protocol: "openai".to_owned(),
        client_version: String::new(),
    };
    let reply = host
        .call("host.models.list", encode_params(&request)?, Vec::new())
        .await
        .map_err(session_fault)?;
    let result: ModelListResult =
        serde_json::from_value(reply.result).map_err(|_| invalid_result())?;
    Ok(result.models)
}

/// 非流式生成调用；返回正文文本与用量事实。
/// `account_id` 为 `None` 时交给宿主正常调度，否则收窄到指定账号。
/// `reasoning_effort` 为 `None` 时不写 `reasoning` 字段，走模型默认推理强度。
pub async fn generate(
    host: &HostClient,
    client_key_id: &str,
    model: &str,
    provider: Option<&str>,
    account_id: Option<&str>,
    reasoning_effort: Option<&str>,
    prompt: &str,
) -> Result<GenerateOutcome, PluginFault> {
    let request = ModelExecuteRequest {
        client_key_id: Some(client_key_id.to_owned()),
        model: model.to_owned(),
        protocol: "openai".to_owned(),
        operation: ModelOperation::Generate,
        provider: provider.map(str::to_owned),
        account_id: account_id.map(str::to_owned),
        previous_response_id: None,
    };
    let mut body = serde_json::json!({
        "model": model,
        "input": prompt,
        "store": false,
    });
    if let Some(effort) = reasoning_effort {
        body["reasoning"] = serde_json::json!({"effort": effort});
    }
    let reply = host
        .call(
            "host.model.execute",
            encode_params(&request)?,
            encode(&body)?,
        )
        .await
        .map_err(session_fault)?;
    let result: ModelExecuteResult =
        serde_json::from_value(reply.result).map_err(|_| invalid_result())?;
    let batch = ModelEventBatch::decode(&reply.payload).map_err(|_| invalid_result())?;
    let mut outcome = GenerateOutcome {
        response_id: Some(result.request_id.as_str().to_owned()),
        ..GenerateOutcome::default()
    };
    for event in batch.events {
        for fact in event.facts {
            match fact {
                CanonicalEvent::TextDelta { text, .. } => outcome.text.push_str(&text),
                CanonicalEvent::Completed { id, model, reason } => {
                    outcome.response_id = Some(id);
                    outcome.model = model;
                    outcome.finish_reason = Some(
                        match reason {
                            FinishReason::Stop => "stop",
                            FinishReason::Length => "length",
                            FinishReason::ToolCall => "tool_call",
                            FinishReason::ContentFilter => "content_filter",
                            FinishReason::Other => "other",
                        }
                        .to_owned(),
                    );
                }
                CanonicalEvent::Usage { usage } => {
                    outcome.input_tokens = usage.input_tokens;
                    outcome.output_tokens = usage.output_tokens;
                    outcome.reasoning_tokens = usage.reasoning_tokens;
                }
                _ => {}
            }
        }
    }
    Ok(outcome)
}
