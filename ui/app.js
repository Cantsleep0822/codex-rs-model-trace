/*
 * 模型指纹检测页面逻辑：选择 Key / 账号 / 模型 → 生成三条挑战 →
 * 逐条经管理路由调用模型 → 本地指纹归因并回写结果。
 */
(function () {
  'use strict';

  var bridge = window.codexProxyPlugin;
  var bank = window.MODEL_TRACE_BANK;
  var trace = window.ModelTrace;

  // —— 页面状态 ——
  var state = {
    keys: [],
    accounts: [],
    models: [],
    challenges: null,
    run: null,
    busy: false,
    driveGeneration: 0,
    stepInFlight: false,
    stepSentAt: 0,
    lastViewedRun: null,
    detailRunId: null,
    detailRun: null,
    detailTab: 'meta',
    lastResult: null,
    settings: { challenge_count: 3, history_limit: 24, default_effort: null },
    pollFailures: 0,
    needsPoll: false,
    runMissing: false,
  };

  // 桥 invoke 超时是 30s，而管理调用最长约 120s；步骤调用可能先超时再由后端落盘。
  var STEP_RESEND_MS = 150000;
  var POLL_MS = 4000;

  function $(id) {
    return document.getElementById(id);
  }

  function setText(id, text) {
    $(id).textContent = text;
  }

  function show(id, visible) {
    $(id).hidden = !visible;
  }

  function toast(message, kind) {
    var node = $('toast');
    node.textContent = message;
    node.className = 'toast ' + (kind || '');
    node.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { node.hidden = true; }, 4000);
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function decodeJsonBody(result) {
    var text = new TextDecoder('utf-8').decode(result.body || new ArrayBuffer(0));
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error('插件响应不是有效 JSON');
    }
  }

  async function call(method, path, query, body) {
    var input = { method: method, path: path };
    if (query) input.query = query;
    if (body !== undefined) {
      input.contentType = 'application/json';
      input.body = JSON.stringify(body);
    }
    var result = await bridge.request(input);
    var data = decodeJsonBody(result);
    if (result.status < 200 || result.status >= 300) {
      var message = data && data.error ? String(data.error) : ('HTTP ' + result.status);
      var error = new Error(message);
      error.status = result.status;
      throw error;
    }
    return data;
  }

  function option(value, label) {
    var node = document.createElement('option');
    node.value = value;
    node.textContent = label;
    return node;
  }

  function fillSelect(node, items, placeholder) {
    node.textContent = '';
    node.appendChild(option('', placeholder));
    items.forEach(function (item) {
      node.appendChild(option(item.value, item.label));
    });
  }

function accountIdentity(account) {
  return account.email || account.name || account.upstream_user_id || account.account_id;
}

function accountLabel(account) {
  return accountIdentity(account)
    + '（' + account.provider_id + (account.enabled ? '' : '，已停用') + '）';
}

function renderAccountOptions() {
  var select = $('f-account');
  var selected = select.value;
  var keyword = ($('f-account-search').value || '').trim().toLowerCase();

  var accounts = state.accounts.filter(function (account) {
    if (!keyword) return true;
    var searchable = [
      account.email,
      account.name,
      account.upstream_user_id,
      account.account_id,
      account.provider_id
    ].join(' ').toLowerCase();
    return searchable.indexOf(keyword) >= 0;
  });

  fillSelect(
    select,
    accounts.map(function (account) {
      return { value: account.account_id, label: accountLabel(account) };
    }),
    '自动（按 Key 调度）'
  );

  if (selected && accounts.some(function (account) {
    return account.account_id === selected;
  })) {
    select.value = selected;
  }
}

  function hint(message, kind) {
    var node = $('start-hint');
    node.textContent = message;
    node.className = 'form-hint ' + (kind || '');
  }

  // —— 设置 ——

  function applySettings(settings) {
    if (!settings) return;
    if (settings.challenge_count) state.settings.challenge_count = settings.challenge_count;
    if (settings.history_limit) state.settings.history_limit = settings.history_limit;
    if ('default_effort' in settings) state.settings.default_effort = settings.default_effort;
    $('f-count').value = String(state.settings.challenge_count);
    $('f-history').value = String(state.settings.history_limit);
    $('f-def-effort').value = state.settings.default_effort || '';
  }

  function settingsHint(message, kind) {
    var node = $('settings-hint');
    node.textContent = message;
    node.className = 'form-hint ' + (kind || '');
  }

  async function loadSettings() {
    try {
      var data = await call('GET', 'settings');
      applySettings(data.settings);
      settingsHint('');
    } catch (error) {
      settingsHint('设置加载失败，使用默认值。', 'fail');
    }
  }

  async function saveSettings() {
    try {
      var data = await call('POST', 'settings', undefined, {
        challenge_count: Number($('f-count').value),
        history_limit: Number($('f-history').value),
        default_effort: $('f-def-effort').value || null,
      });
      applySettings(data.settings);
      settingsHint('已保存，立即生效。', 'ok');
      loadHistory();
    } catch (error) {
      settingsHint('保存失败：' + error.message, 'fail');
    }
  }

  async function resetSettings() {
    try {
      var data = await call('POST', 'settings-reset', undefined, {});
      applySettings(data.settings);
      settingsHint('已恢复默认。', 'ok');
      loadHistory();
    } catch (error) {
      settingsHint('恢复默认失败：' + error.message, 'fail');
    }
  }

  function refreshStartButton() {
    $('start-btn').disabled = state.busy
      || !$('f-key').value
      || !$('f-model').value
      || !bank;
    $('result-open').disabled = !state.lastResult;
  }

  // —— 初始化与表单 ——

  async function bootstrap() {
    if (!bridge) {
      hint('未检测到宿主页面桥，请在管理端插件页面中打开。', 'fail');
      return;
    }
    if (!bank || !bank.models || !bank.models.length) {
      hint('指纹库未加载，无法开始检测。', 'fail');
    }
    var data = await call('GET', 'bootstrap');
    state.keys = (data.keys || []).filter(function (key) { return key.enabled; });
    state.accounts = data.accounts || [];
    fillSelect(
      $('f-key'),
      state.keys.map(function (key) {
        return { value: key.id, label: key.name ? key.name + '（' + key.id + '）' : key.id };
      }),
      '选择 Key'
    );
    // Key 默认选第一个可用项，直接带出模型目录。
    if (state.keys.length) $('f-key').value = state.keys[0].id;
    renderAccountOptions();
    await loadModels();
    hint('共 ' + state.accounts.length + ' 个上游账号；默认为自动调度。', '');
  }

  async function loadModels() {
    var keyId = $('f-key').value;
    state.models = [];
    fillSelect($('f-model'), [], keyId ? '加载中…' : '先选择 Key');
    if (!keyId) return;
    try {
      var data = await call('GET', 'models', 'key=' + encodeURIComponent(keyId));
      state.models = data.models || [];
      fillSelect(
        $('f-model'),
        state.models.map(function (model) { return { value: model, label: model }; }),
        '选择模型'
      );
      hint(state.models.length ? '模型目录已加载，共 ' + state.models.length + ' 个。' : '该 Key 当前没有可见模型。', state.models.length ? 'ok' : 'fail');
    } catch (error) {
      fillSelect($('f-model'), [], '选择模型');
      hint('模型目录加载失败：' + error.message, 'fail');
    }
    refreshStartButton();
  }

  function selectedAccount() {
    var id = $('f-account').value;
    if (!id) return null;
    return state.accounts.find(function (account) { return account.account_id === id; }) || null;
  }

  // —— 运行驱动 ——

  async function startRun() {
    if (state.busy) return;
    var keyId = $('f-key').value;
    var model = $('f-model').value;
    if (!keyId || !model) return;
    var account = selectedAccount();
    state.busy = true;
    state.driveGeneration += 1;
    refreshStartButton();
    try {
      state.challenges = trace.generateChallenges(state.settings.challenge_count);
      var keyName = '';
      state.keys.forEach(function (key) { if (key.id === keyId) keyName = key.name || ''; });
      var created = await call('POST', 'runs', undefined, {
        model: model,
        client_key_id: keyId,
        client_key_name: keyName || null,
        reasoning_effort: $('f-effort').value || null,
        account_id: account ? account.account_id : null,
        provider: account ? account.provider_id : null,
        account_name: account ? (account.email || account.name || account.upstream_user_id || null) : null,
        queries: state.challenges.map(function (challenge) {
          return { prompt: challenge.prompt, expected_count: challenge.expected_count };
        }),
      });
      state.run = created.run;
      state.lastViewedRun = created.run;
      state.lastResult = null;
      state.pollFailures = 0;
      state.needsPoll = false;
      state.runMissing = false;
      show('result-modal', false);
      refreshStartButton();
      toast('已创建检测任务，开始逐题调用模型。', 'ok');
      void drive();
    } catch (error) {
      toast('创建检测失败：' + error.message, 'fail');
      state.busy = false;
      refreshStartButton();
    }
  }

  // 每轮只推进一道挑战；步骤调用超时后靠轮询恢复状态，超时才重发。
  async function drive() {
    var generation = ++state.driveGeneration;
    var runId = state.run.id;
    var current = function () {
      return state.busy && state.driveGeneration === generation && state.run && state.run.id === runId;
    };
    state.stepInFlight = false;
    state.stepSentAt = 0;
    while (current()) {
      var run = state.run;
      if (['completed', 'cancelled', 'failed'].indexOf(run.status) >= 0) {
        renderRun(run);
        await afterRunFinished(run);
        return;
      }
      var allAccepted = run.queries.every(function (query) { return query.status === 'accepted'; });
      if (allAccepted && run.status === 'collecting') {
        await finishAttribution(run);
        return;
      }
      var running = run.queries.some(function (query) { return query.status === 'running'; });
      var shouldStep = !state.stepInFlight
        && (!running || Date.now() - state.stepSentAt > STEP_RESEND_MS);
      if (shouldStep) {
        state.stepInFlight = true;
        state.stepSentAt = Date.now();
        call('POST', 'run/step', undefined, { id: run.id }).then(function (data) {
          state.needsPoll = false;
          if (current() && data && data.run && data.run.id === runId) {
            state.run = data.run;
            state.lastViewedRun = data.run;
            renderRun(data.run, data.response_text);
          }
        }).catch(function () {
          // 桥 30s 超时早于管理调用上限；标记未确认，交给轮询恢复而不是重复发起。
          if (current()) {
            state.needsPoll = true;
            renderRun(state.run);
          }
        }).finally(function () {
          if (current()) state.stepInFlight = false;
        });
      }
      await sleep(POLL_MS);
      if (!current()) return;
      try {
        var latest = await call('GET', 'run', 'id=' + encodeURIComponent(runId));
        state.pollFailures = 0;
        if (current() && latest && latest.run && latest.run.id === runId) {
          if (!state.stepInFlight) state.needsPoll = false;
          state.run = latest.run;
          state.lastViewedRun = latest.run;
          renderRun(latest.run);
        }
      } catch (error) {
        if (!current()) return;
        state.pollFailures += 1;
        if (error.status === 404) {
          state.runMissing = true;
          state.busy = false;
          renderRun(state.run);
          refreshStartButton();
          return;
        }
        renderRun(state.run);
        if (state.pollFailures <= 2) toast('状态刷新失败：' + error.message, 'fail');
      }
    }
  }

  async function finishAttribution(run) {
    var generation = state.driveGeneration;
    var current = function () { return state.busy && state.driveGeneration === generation && state.run && state.run.id === run.id; };
    try {
      var outputs = run.queries.map(function (query) {
        return { expected_count: query.expected_count, numbers: query.numbers || [] };
      });
      var result = trace.analyzeGlobalOutputs(outputs, bank);
      var reported = await call('POST', 'run/report', undefined, { id: run.id, result: result });
      if (!current()) return;
      state.run = reported.run || run;
      state.lastViewedRun = state.run;
      renderResult(result);
      renderRun(state.run);
      toast('归因完成：' + result.prediction_name + '（' + formatPercent(result.probability) + '）', 'ok');
    } catch (error) {
      if (!current()) return;
      // 归因落盘失败不能伪造后端 failed 状态，保留 collecting 供用户继续。
      toast('归因保存失败，可从历史继续：' + error.message, 'fail');
    } finally {
      if (current()) {
        state.busy = false;
        refreshStartButton();
        loadHistory();
      }
    }
  }

  async function afterRunFinished(run) {
    state.busy = false;
    refreshStartButton();
    if (run.result) {
      renderResult(run.result);
    }
    loadHistory();
  }

  async function cancelRun() {
    if (!state.run) return;
    var runId = state.run.id;
    var generation = state.driveGeneration;
    try {
      var data = await call('POST', 'run/cancel', undefined, { id: runId });
      if (!state.run || state.run.id !== runId || state.driveGeneration !== generation) return;
      state.run = data.run || state.run;
      state.busy = false;
      state.driveGeneration += 1;
      refreshStartButton();
      renderRun(state.run);
      toast('已请求取消，正在进行的模型调用由宿主决定是否中断。', '');
    } catch (error) {
      toast('取消失败：' + error.message, 'fail');
    }
  }

  async function showDetail(id) {
    if (state.detailRunId === id) {
      state.detailRunId = null;
      state.detailRun = null;
      renderHistory(state.runsCache || []);
      return;
    }
    try {
      var data = await call('GET', 'run', 'id=' + encodeURIComponent(id));
      if (!data.run) throw new Error('运行不存在');
      state.detailRunId = id;
      state.detailRun = data.run;
      state.detailTab = 'meta';
      state.lastViewedRun = data.run;
      renderHistory(state.runsCache || []);
      if (data.run.result) renderResult(data.run.result);
    } catch (error) {
      toast('打开详情失败：' + error.message, 'fail');
    }
  }

  function attemptCell(attempt) {
    if (attempt.error) return attempt.error;
    var parts = ['解析 ' + (attempt.parsed_numbers != null ? attempt.parsed_numbers : 0)
      + '/' + (attempt.minimum_numbers || '—') + ' 个'];
    if (attempt.upstream_model) parts.push('上游 ' + attempt.upstream_model);
    if (attempt.finish_reason) parts.push('finish ' + attempt.finish_reason);
    var tokens = [];
    if (attempt.input_tokens != null) tokens.push('入 ' + attempt.input_tokens);
    if (attempt.output_tokens != null) tokens.push('出 ' + attempt.output_tokens);
    if (tokens.length) parts.push('token ' + tokens.join('/'));
    return parts.join(' · ');
  }

  function renderRunDetail(run) {
    var account = run.account_name || run.account_id || '自动';
    var prediction = run.result
      ? (run.result.prediction_name || run.result.prediction || '—')
        + '（' + formatPercent(run.result.probability) + '）'
      : '—';
    var fields = [
      ['执行 Key', run.client_key_name || run.client_key_id || '—'],
      ['模型', run.model],
      ['上游账号', account + (run.provider ? '（' + run.provider + '）' : '')],
      ['推理强度', run.reasoning_effort || '自动'],
      ['状态', run.status + (run.status_note ? '：' + run.status_note : '')],
      ['归因', prediction],
      ['更新于', formatTime(run.updated_at_ms)],
    ];
    var verdict = '';
    if (run.result) {
      verdict = '<div class="detail-verdict"><span class="verdict">'
        + escapeHtml(run.result.prediction_name || run.result.prediction || '—') + '</span>'
        + '<span class="sub">概率 ' + formatPercent(run.result.probability)
        + ' · 家族 ' + escapeHtml(run.result.family_prediction_name || run.result.family_prediction || '—')
        + '（' + formatPercent(run.result.family_probability) + '）'
        + ' · 计入 ' + (run.result.used_outputs || 0) + ' 道挑战</span></div>';
    }
    return verdict + '<dl class="meta-grid">' + fields.map(function (field) {
      return '<div><div class="m-label">' + escapeHtml(field[0]) + '</div>'
        + '<div class="m-value">' + escapeHtml(field[1]) + '</div></div>';
    }).join('') + '</dl>';
  }

  function renderQueryDetail(query, index) {
    var attemptsRows = (query.attempts || []).map(function (attempt) {
      return '<tr><td class="mono">' + attempt.index + '</td>'
        + '<td>' + statusTag(attempt.status) + '</td>'
        + '<td>' + escapeHtml(attemptCell(attempt)) + '</td>'
        + '<td class="mono detail-preview">' + escapeHtml(attempt.text_preview || '—') + '</td></tr>';
    }).join('');
    if (!attemptsRows) {
      attemptsRows = '<tr><td colspan="4" class="empty">尚无调用</td></tr>';
    }
    var numbers = query.numbers && query.numbers.length
      ? '<h4 class="block-title">解析数字（' + query.numbers.length + ' 个）</h4>'
        + '<pre class="numbers-text mono">' + escapeHtml(query.numbers.join(', ')) + '</pre>'
      : '';
    return '<div class="dq-meta">目标 ' + query.expected_count + ' 个数字 · 尝试 '
      + (query.attempts || []).length + ' 次 · ' + statusTag(query.status) + '</div>'
      + '<h4 class="block-title">请求 Prompt</h4>'
      + '<pre class="prompt-text">' + escapeHtml(query.prompt) + '</pre>'
      + '<div class="table-wrap" style="margin-top:8px"><table class="table compact">'
      + '<thead><tr><th>次数</th><th>结果</th><th>明细</th><th>回答预览</th></tr></thead>'
      + '<tbody>' + attemptsRows + '</tbody></table></div>'
      + numbers;
  }

  function renderDetailPane() {
    var run = state.detailRun;
    if (!run) return '';
    var tabs = ['<button class="tab' + (state.detailTab === 'meta' ? ' active' : '')
      + '" data-tab="meta">概览</button>'];
    run.queries.forEach(function (query, index) {
      var key = 'q' + index;
      tabs.push('<button class="tab' + (state.detailTab === key ? ' active' : '')
        + '" data-tab="' + key + '">挑战 ' + (index + 1) + '</button>');
    });
    var pane;
    if (state.detailTab === 'meta') {
      pane = renderRunDetail(run);
    } else {
      var index = Number(state.detailTab.slice(1));
      pane = run.queries[index] ? renderQueryDetail(run.queries[index], index) : '';
    }
    return '<div class="detail-tabs">' + tabs.join('') + '</div>'
      + '<div class="detail-pane">' + pane + '</div>';
  }

  async function resumeRun(id) {
    if (state.busy) {
      toast('当前有检测进行中。', 'fail');
      return;
    }
    state.busy = true;
    state.driveGeneration += 1;
    refreshStartButton();
    try {
      var data = await call('GET', 'run', 'id=' + encodeURIComponent(id));
      if (!data.run) throw new Error('运行不存在');
      var run = data.run;
      state.run = run;
      state.lastViewedRun = run;
      state.pollFailures = 0;
      state.needsPoll = false;
      state.runMissing = false;
      renderRun(run);
      if (run.result) renderResult(run.result);
      var finished = ['completed', 'cancelled', 'failed'].includes(run.status);
      var allAccepted = run.queries.every(function (query) { return query.status === 'accepted'; });
      if (finished) {
        state.busy = false;
        refreshStartButton();
        return;
      }
      if (allAccepted) {
        // 三道挑战已接受但未回写结果：补做本地归因。
        state.busy = true;
        refreshStartButton();
        await finishAttribution(run);
        return;
      }
      // 接管未完成检测：继续驱动后续步骤。
      state.busy = true;
      refreshStartButton();
      void drive();
      toast('已接管未完成的检测。', 'ok');
    } catch (error) {
      state.busy = false;
      refreshStartButton();
      toast('打开运行失败：' + error.message, 'fail');
    }
  }

  // —— 渲染 ——

  function statusTag(status) {
    var map = {
      pending: ['待执行', ''],
      running: ['调用中', 'run'],
      accepted: ['已接受', 'ok'],
      collecting: ['待归因', 'run'],
      interrupted: ['已中断', 'warn'],
      completed: ['已完成', 'ok'],
      cancelled: ['已取消', 'warn'],
      failed: ['失败', 'bad'],
      rejected: ['未通过', 'warn'],
    };
    var entry = map[status] || [status, ''];
    return '<span class="tag ' + entry[1] + '">' + escapeHtml(entry[0]) + '</span>';
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, function (char) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char];
    });
  }

  function formatTime(ms) {
    if (!ms) return '—';
    var date = new Date(Number(ms));
    var pad = function (value) { return String(value).padStart(2, '0'); };
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
      + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
  }

  function formatDuration(ms) {
    if (ms == null || isNaN(ms) || ms < 0) return '—';
    var seconds = Math.floor(ms / 1000);
    if (seconds < 60) return seconds + ' 秒';
    var minutes = Math.floor(seconds / 60);
    if (minutes < 60) return minutes + ' 分 ' + (seconds % 60) + ' 秒';
    return Math.floor(minutes / 60) + ' 小时 ' + (minutes % 60) + ' 分';
  }

  function formatPercent(value) {
    if (value === null || value === undefined || isNaN(value)) return '—';
    return (value * 100).toFixed(1) + '%';
  }

  function renderRun(run, responseText) {
    show('run-card', true);
    setText('run-title', '当前检测：' + run.model);
    var account = run.account_name || run.account_id || '自动';
    var keyLabel = run.client_key_name || run.client_key_id || '—';
    setText('run-sub', 'Key：' + keyLabel + ' · 账号：' + account + ' · 创建：' + formatTime(run.created_at_ms)
      + ' · 状态：' + run.status + (run.status_note ? '（' + run.status_note + '）' : ''));
    var total = run.queries.length;
    var accepted = run.queries.filter(function (query) { return query.status === 'accepted'; }).length;
    var runningQuery = run.queries.filter(function (query) { return query.status === 'running'; })[0];
    var progressBar = $('run-progress');
    progressBar.max = total;
    progressBar.value = run.status === 'completed' ? total : accepted;
    var elapsed = (run.completed_at_ms || Date.now()) - run.created_at_ms;
    var parts = ['已完成 ' + accepted + '/' + total + ' 道挑战'];
    if (runningQuery) parts.push('第 ' + (runningQuery.index + 1) + ' 题第 ' + (runningQuery.attempts.length || 1) + ' 次调用进行中');
    if (run.status === 'collecting') parts.push('本地归因中');
    parts.push('已耗时 ' + formatDuration(elapsed));
    setText('run-progress-text', parts.join(' · '));
    var feedback = '';
    if (state.runMissing) feedback = '该任务记录已被删除，可从历史重新发起。';
    else if (state.pollFailures > 0) feedback = '连接不稳定，轮询连续失败 ' + state.pollFailures + ' 次，仍在自动恢复。';
    else if (state.needsPoll) feedback = '上一步调用结果未确认，正在通过轮询恢复，未重复发起模型调用。';
    else if (run.status === 'interrupted') feedback = '检测曾中断，点击「继续检测」从已记账的尝试恢复，不额外调用未记账请求。';
    var feedbackNode = $('run-feedback');
    feedbackNode.hidden = !feedback;
    feedbackNode.textContent = feedback;
    var terminal = ['completed', 'cancelled', 'failed'].includes(run.status);
    $('cancel-btn').disabled = terminal;
    $('resume-btn').hidden = terminal || state.busy || state.runMissing;
    if (!state.busy && !terminal) $('resume-btn').disabled = false;
    var container = $('queries');
    container.textContent = '';
    run.queries.forEach(function (query, index) {
      var card = document.createElement('div');
      card.className = 'query ' + (query.status === 'running' ? 'running' : query.status === 'accepted' ? 'accepted' : '');
      var attempts = (query.attempts || []).map(function (attempt) {
        if (attempt.error) {
          return '第 ' + attempt.index + ' 次：' + attempt.error;
        }
        return '第 ' + attempt.index + ' 次：解析 ' + (attempt.parsed_numbers || 0)
          + '/' + (attempt.minimum_numbers || '—')
          + (attempt.upstream_model ? ' · 上游 ' + attempt.upstream_model : '');
      }).join('\n');
      card.innerHTML = '<div class="q-title"><span>挑战 ' + (index + 1) + '</span>' + statusTag(query.status) + '</div>'
        + '<div class="q-meta">目标 ' + query.expected_count + ' 个数字'
        + (query.numbers ? ' · 已解析 ' + query.numbers.length + ' 个' : '') + '</div>'
        + '<div class="q-attempts' + (attempts && attempts.includes('错误') ? ' q-error' : '') + '">'
        + escapeHtml(attempts || '等待调用') + '</div>';
      container.appendChild(card);
    });
    var preview = responseText;
    if (!preview) {
      var latest = run.queries.map(function (query) {
        return (query.attempts || []).slice(-1)[0];
      }).filter(Boolean).slice(-1)[0];
      preview = latest && latest.text_preview;
    }
    show('response-preview', Boolean(preview));
    if (preview) setText('response-text', preview);
  }

  function renderResult(result) {
    state.lastResult = result;
    $('result-open').disabled = false;
    var summary = $('result-summary');
    summary.innerHTML = '<span class="verdict">' + escapeHtml(result.prediction_name || result.prediction) + '</span>'
      + '<span class="sub">概率 ' + formatPercent(result.probability) + '</span>'
      + '<span class="sub">家族 ' + escapeHtml(result.family_prediction_name || result.family_prediction || '—')
      + '（' + formatPercent(result.family_probability) + '）</span>'
      + '<span class="sub">计入 ' + (result.used_outputs || 0) + ' 道挑战'
      + ' · 校准 β=' + (result.calibration && result.calibration.beta != null ? Number(result.calibration.beta).toFixed(2) : '—')
      + (result.calibration && result.calibration.cv_accuracy != null
        ? ' · 交叉验证 ' + formatPercent(result.calibration.cv_accuracy) : '') + '</span>';
    setText('result-sub', '推测模型与实际供应方的差异越小，预测越可能指向真实上游型号。');

    var families = $('family-body');
    families.innerHTML = '';
    (result.family_probabilities || []).forEach(function (family) {
      var row = document.createElement('div');
      row.className = 'bar-row';
      row.innerHTML = '<span class="name">' + escapeHtml(family.display_name || family.family) + '</span>'
        + '<span class="bar"><i style="width:' + Math.min(100, family.probability * 100).toFixed(1) + '%"></i></span>'
        + '<span class="value">' + formatPercent(family.probability) + '</span>';
      families.appendChild(row);
    });

    var body = $('models-body');
    body.innerHTML = '';
    (result.results || []).forEach(function (item) {
      var row = document.createElement('tr');
      row.innerHTML = '<td>' + escapeHtml(item.display_name || item.model) + '</td>'
        + '<td>' + formatPercent(item.probability) + '</td>'
        + '<td>' + formatPercent(item.conditional_probability) + '</td>'
        + '<td>' + formatPercent(item.profile_similarity) + '</td>'
        + '<td>' + (item.score != null ? Number(item.score).toFixed(3) : '—') + '</td>';
      body.appendChild(row);
    });

    var diag = $('diagnostics-body');
    diag.innerHTML = '';
    (result.diagnostics || []).forEach(function (item) {
      var row = document.createElement('tr');
      row.innerHTML = '<td>挑战 ' + (item.index + 1) + '</td>'
        + '<td>' + escapeHtml(state.lastViewedRun && state.lastViewedRun.queries[item.index]
          ? state.lastViewedRun.queries[item.index].expected_count : '—') + '</td>'
        + '<td>' + (item.parsed_numbers != null ? item.parsed_numbers : '—') + '</td>'
        + '<td>' + (item.minimum_numbers != null ? item.minimum_numbers : '—') + '</td>'
        + '<td>' + (item.accepted ? '<span class="tag ok">计入</span>' : '<span class="tag warn">未计入</span>') + '</td>';
      diag.appendChild(row);
    });
  }

  async function loadHistory() {
    try {
      var data = await call('GET', 'runs');
      renderHistory(data.runs || []);
    } catch (error) {
      toast('历史记录加载失败：' + error.message, 'fail');
    }
  }

  function renderHistory(runs) {
    state.runsCache = runs;
    var body = $('history-body');
    body.innerHTML = '';
    var keyword = ($('history-search').value || '').trim().toLowerCase();
    var status = $('history-status').value;
    var activeStatuses = ['pending', 'running', 'interrupted', 'collecting'];
    var filtered = runs.filter(function (run) {
      if (status === 'active' ? activeStatuses.indexOf(run.status) < 0
        : status && run.status !== status) return false;
      if (!keyword) return true;
      var text = [run.model, run.client_key_name, run.client_key_id, run.account_name,
        run.account_id, run.prediction].join(' ').toLowerCase();
      return text.indexOf(keyword) >= 0;
    });
    var limit = state.settings.history_limit || filtered.length;
    var shown = filtered.slice(0, limit);
    if (!shown.length) {
      state.detailRunId = null;
      state.detailRun = null;
      body.innerHTML = '<tr><td colspan="7" class="empty">'
        + (runs.length ? '没有匹配的记录' : '暂无记录') + '</td></tr>';
      setText('history-sub', '共 ' + runs.length + ' 次检测，筛选后无匹配。');
      return;
    }
    var label = '最近 ' + shown.length + ' / ' + filtered.length + ' 次检测';
    if (keyword || status) label += '（已筛选，全部 ' + runs.length + ' 次）';
    setText('history-sub', label + '，点开可查看请求与回答明细。');
    shown.forEach(function (run) {
      var row = document.createElement('tr');
      var expanded = state.detailRunId === run.id;
      var account = run.account_name || run.account_id || '自动';
      var prediction = run.prediction
        ? escapeHtml(run.prediction) + '（' + formatPercent(run.probability) + '）'
        : '—';
      var finished = ['completed', 'cancelled', 'failed'].includes(run.status);
      var actions = '<button class="btn link" data-detail="' + escapeHtml(run.id) + '">'
        + (expanded ? '收起' : '查看') + '</button>';
      if (!finished) {
        actions += ' · <button class="btn link" data-open="' + escapeHtml(run.id) + '">继续</button>';
      }
      actions += ' · <button class="btn link" data-delete="' + escapeHtml(run.id) + '">删除</button>';
      row.innerHTML = '<td class="mono">' + formatTime(run.created_at_ms) + '</td>'
        + '<td>' + escapeHtml(run.client_key_name || '—') + '</td>'
        + '<td>' + escapeHtml(run.model) + '</td>'
        + '<td>' + escapeHtml(account) + '</td>'
        + '<td>' + statusTag(run.status) + '</td>'
        + '<td>' + prediction + '</td>'
        + '<td>' + actions + '</td>';
      body.appendChild(row);
      if (expanded) {
        var detail = document.createElement('tr');
        detail.className = 'history-detail';
        detail.innerHTML = '<td colspan="7"><div class="detail-inline">'
          + renderDetailPane() + '</div></td>';
        body.appendChild(detail);
      }
    });
  }

  async function deleteRun(id) {
    try {
      await call('POST', 'run/delete', undefined, { id: id });
      if (state.run && state.run.id === id) {
        state.driveGeneration += 1;
        state.busy = false;
        state.run = null;
        show('run-card', false);
        refreshStartButton();
      }
      toast('已删除。', 'ok');
      loadHistory();
    } catch (error) {
      toast('删除失败：' + error.message, 'fail');
    }
  }

  // —— 事件 ——

  function bind() {
    $('bootstrap-btn').addEventListener('click', function () {
      bootstrap().catch(function (error) { hint('初始化失败：' + error.message, 'fail'); });
    });
    $('f-key').addEventListener('change', function () {
      loadModels().then(refreshStartButton);
    });
    $('f-model').addEventListener('change', refreshStartButton);
    $('f-account-search').addEventListener('input', function () {
      renderAccountOptions();
      refreshStartButton();
    });
    $('f-account').addEventListener('change', refreshStartButton);
    $('start-btn').addEventListener('click', function () { void startRun(); });
    $('cancel-btn').addEventListener('click', function () { void cancelRun(); });
    $('resume-btn').addEventListener('click', function () {
      if (state.run && !state.busy) {
        state.busy = true;
        state.pollFailures = 0;
        state.runMissing = false;
        refreshStartButton();
        $('resume-btn').disabled = true;
        void drive();
      }
    });
    var filterApply = function () { renderHistory(state.runsCache || []); };
    $('history-search').addEventListener('input', filterApply);
    $('history-status').addEventListener('change', filterApply);
    $('history-refresh').addEventListener('click', function () { void loadHistory(); });
    $('settings-save').addEventListener('click', function () { void saveSettings(); });
    $('settings-reset').addEventListener('click', function () { void resetSettings(); });
    $('settings-open').addEventListener('click', function () { show('settings-modal', true); });
    $('settings-close').addEventListener('click', function () { show('settings-modal', false); });
    $('settings-modal').addEventListener('click', function (event) {
      if (event.target === $('settings-modal')) show('settings-modal', false);
    });
    $('result-open').addEventListener('click', function () { show('result-modal', true); });
    $('result-close').addEventListener('click', function () { show('result-modal', false); });
    $('result-modal').addEventListener('click', function (event) {
      if (event.target === $('result-modal')) show('result-modal', false);
    });
    $('history-body').addEventListener('click', function (event) {
      var target = event.target;
      if (!(target instanceof HTMLElement)) return;
      var tab = target.getAttribute('data-tab');
      if (tab) {
        state.detailTab = tab;
        renderHistory(state.runsCache || []);
        return;
      }
      var detail = target.getAttribute('data-detail');
      var open = target.getAttribute('data-open');
      var del = target.getAttribute('data-delete');
      if (detail) void showDetail(detail);
      else if (open) void resumeRun(open);
      else if (del) void deleteRun(del);
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    bind();
    // 生效默认 effort：持久化 default_effort 优先，否则 low；保存/恢复默认不再覆盖表单已选项。
    loadSettings().then(function () {
      if (!$('f-effort').value) $('f-effort').value = state.settings.default_effort || 'low';
    });
    bootstrap().catch(function (error) { hint('初始化失败：' + error.message, 'fail'); });
    loadHistory();
  });
})();
