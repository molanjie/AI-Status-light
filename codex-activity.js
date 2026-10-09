const LABELS = {
  read: "读取文件", write: "修改文件", command: "执行命令", search: "检索资料",
  tool: "调用工具", processing: "处理中", input: "等待输入", approval: "等待确认",
};

function classifyTool(name, args) {
  const tool = String(name || "").split(/[.:]/).pop();
  if (/request_user_input|request_permissions/.test(tool)) return null;
  if (/apply_patch|write_file|edit_file|patch_apply/.test(tool)) return "write";
  if (/read_file|fetch_file|view_image|list_files/.test(tool)) return "read";
  if (/search|web__run/.test(tool) || /^web[.:]/.test(String(name))) return "search";
  if (/exec_command|shell|exec_command_begin/.test(tool)) {
    try {
      const command = (typeof args === "string" ? JSON.parse(args) : args || {}).cmd || "";
      if (/^\s*(?:Get-Content|Select-String|rg|cat|type|ls|dir|head|tail)\b/i.test(command)) return "read";
    } catch {}
    return "command";
  }
  return "tool";
}

function clearActivity(state) {
  state.activeTools = new Map();
  state.resolvedTools = new Set();
}

function trackActivity(event, state) {
  const payload = event.payload || {};
  const at = Date.parse(event.timestamp);
  if (!state.active || !Number.isFinite(at) || at < (state.lastStartedAt || 0)) return;
  if (payload.turn_id && state.turnId && payload.turn_id !== state.turnId) return;
  const type = payload.type;
  const callId = payload.call_id || payload.id;
  if (!callId) return;
  state.activeTools = state.activeTools || new Map();
  state.resolvedTools = state.resolvedTools || new Set();
  if (["function_call", "custom_tool_call", "exec_command_begin", "patch_apply_begin"].includes(type)) {
    const kind = type === "patch_apply_begin" ? "write" : classifyTool(payload.name || type, payload.arguments || payload);
    if (!kind || state.activeTools.has(callId) || state.resolvedTools.has(callId)) return;
    state.activeTools.set(callId, { kind, startedAt: at });
    if (state.activeTools.size > 100) state.activeTools.delete(state.activeTools.keys().next().value);
  } else if (["function_call_output", "custom_tool_call_output", "exec_command_end", "patch_apply_end"].includes(type)) {
    state.activeTools.delete(callId);
    state.resolvedTools.add(callId);
    if (state.resolvedTools.size > 256) state.resolvedTools.delete(state.resolvedTools.values().next().value);
  }
}

function getCurrentAction(state) {
  if (state.waiting) {
    const first = state.pendingInputs && state.pendingInputs.values().next().value;
    const kind = first && /approval|permissions/.test(first.type) ? "approval" : "input";
    return { kind, label: LABELS[kind], startedAt: state.waitingAt || state.lastStartedAt || 0 };
  }
  if (!state.active) return null;
  const current = [...(state.activeTools || new Map()).values()].sort((a, b) => b.startedAt - a.startedAt)[0];
  const kind = current ? current.kind : "processing";
  return { kind, label: LABELS[kind], startedAt: current ? current.startedAt : state.lastStartedAt || 0 };
}

module.exports = { clearActivity, trackActivity, getCurrentAction };
