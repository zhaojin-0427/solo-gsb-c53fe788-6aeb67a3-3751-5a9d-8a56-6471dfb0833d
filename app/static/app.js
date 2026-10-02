/* 无线话筒频点协调台 —— 原生 JavaScript */
"use strict";

const $ = (sel) => document.querySelector(sel);

// ---------------- 状态 ----------------
const state = {
  planId: null,
  devices: [],          // {name, candidatesText, current, locked}
  forbidden: [],        // {lo, hi}
  result: null,
};

// ---------------- 工具 ----------------
function parseCandidates(text) {
  const parts = String(text).split(/[\s,，、;；]+/).filter(Boolean);
  const vals = parts.map((p) => Number(p));
  return vals;
}

function buildPlan() {
  const errs = [];
  if (state.devices.length < 2 || state.devices.length > 8) {
    errs.push("话筒数量须为 2～8 支");
  }
  const devices = state.devices.map((d, idx) => {
    const vals = parseCandidates(d.candidatesText);
    const id = idx + 1;
    if (vals.length < 1 || vals.length > 12) {
      errs.push(`设备 ${id}：候选频点须为 1～12 个`);
    }
    if (vals.some((v) => !Number.isInteger(v) || v <= 0)) {
      errs.push(`设备 ${id}：候选频点必须为正整数`);
    } else if (new Set(vals).size !== vals.length) {
      errs.push(`设备 ${id}：候选频点必须互异`);
    }
    const current = d.current === "" || d.current == null
      ? null : Number(d.current);
    if (current !== null) {
      if (!Number.isInteger(current) || current <= 0) {
        errs.push(`设备 ${id}：现用频点必须为正整数或留空`);
      } else if (vals.length && !vals.includes(current)) {
        errs.push(`设备 ${id}：现用频点 ${current} 不在候选频点中`);
      }
    }
    if (d.locked && current === null) {
      errs.push(`设备 ${id}：锁定设备必须填写现用频点`);
    }
    return {
      name: d.name || "",
      candidates: vals,
      current,
      locked: !!d.locked,
    };
  });

  const settings = {
    min_gap: Number($("#minGap").value),
    imd_tolerance: Number($("#imdTol").value),
    time_limit: Number($("#timeLimit").value),
  };
  if (!(Number.isInteger(settings.min_gap) && settings.min_gap >= 1)) {
    errs.push("最小频差 d 须为正整数");
  }
  if (!(Number.isInteger(settings.imd_tolerance) && settings.imd_tolerance >= 0)) {
    errs.push("互调容差 g 须为非负整数");
  }
  if (!(Number.isInteger(settings.time_limit) && settings.time_limit >= 1)) {
    errs.push("求解时限须为正整数（秒）");
  }

  const forbidden = state.forbidden.map((f, idx) => {
    const lo = Number(f.lo);
    const hi = Number(f.hi);
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo <= 0 || hi <= 0) {
      errs.push(`禁用区间 ${idx + 1}：端点须为正整数`);
    } else if (lo > hi) {
      errs.push(`禁用区间 ${idx + 1}：起点不得大于终点`);
    }
    return { lo, hi };
  });

  const name = $("#planName").value.trim();
  if (!name) errs.push("请填写演出方案名称");

  return { errs, plan: { name, devices, forbidden, settings } };
}

function markInvalidRows() {
  document.querySelectorAll("#devTbody tr").forEach((tr, idx) => {
    const d = state.devices[idx];
    const vals = parseCandidates(d.candidatesText);
    const cur = d.current === "" || d.current == null ? null : Number(d.current);
    const candBad = vals.length < 1 || vals.length > 12 ||
      vals.some((v) => !Number.isInteger(v) || v <= 0) ||
      new Set(vals).size !== vals.length;
    tr.querySelector(".cand-input").classList.toggle("invalid", candBad);
    const curBad = cur !== null &&
      (!Number.isInteger(cur) || cur <= 0 || !vals.includes(cur));
    tr.querySelector(".cur-input").classList.toggle(
      "invalid", curBad || (d.locked && cur === null));
  });
}

// 数据被修改后，旧求解结果即失效
function invalidateResult() {
  if (state.result) {
    state.result = null;
    renderResult();
  }
}

// ---------------- 设备行渲染 ----------------
function renderDevices() {
  const tbody = $("#devTbody");
  tbody.innerHTML = "";
  state.devices.forEach((d, idx) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="col-id">${idx + 1}</td>
      <td><input type="text" maxlength="64" placeholder="如：主唱麦"
          value="${escapeAttr(d.name)}" data-k="name"></td>
      <td><input class="cand-input" type="text"
          placeholder="如：600000 600200 600400"
          value="${escapeAttr(d.candidatesText)}" data-k="candidatesText"></td>
      <td><input class="cur-input" type="number" min="1" step="1"
          value="${d.current == null ? "" : d.current}" data-k="current"></td>
      <td style="text-align:center">
        <input type="checkbox" data-k="locked" ${d.locked ? "checked" : ""}>
      </td>
      <td><button type="button" class="del-row danger">删除</button></td>`;
    tr.querySelectorAll("[data-k]").forEach((el) => {
      const key = el.dataset.k;
      const ev = el.type === "checkbox" ? "change" : "input";
      el.addEventListener(ev, () => {
        state.devices[idx][key] = el.type === "checkbox" ? el.checked : el.value;
        markInvalidRows();
        drawSpectrum();
        invalidateResult();
      });
    });
    tr.querySelector(".del-row").addEventListener("click", () => {
      if (state.devices.length <= 2) {
        alert("至少保留 2 支话筒");
        return;
      }
      state.devices.splice(idx, 1);
      state.result = null;
      renderDevices();
      renderResult();
    });
    tbody.appendChild(tr);
  });
  $("#btnAddDevice").disabled = state.devices.length >= 8;
  markInvalidRows();
}

function escapeAttr(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

// ---------------- 禁用区间渲染 ----------------
function renderForbidden() {
  const tbody = $("#forbiddenTbody");
  tbody.innerHTML = "";
  state.forbidden.forEach((f, idx) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="number" min="1" step="1" value="${f.lo}" data-k="lo"></td>
      <td><input type="number" min="1" step="1" value="${f.hi}" data-k="hi"></td>
      <td><button type="button" class="del-row danger">删除</button></td>`;
    tr.querySelectorAll("[data-k]").forEach((el) => {
      el.addEventListener("input", () => {
        state.forbidden[idx][el.dataset.k] = el.value;
        drawSpectrum();
        invalidateResult();
      });
    });
    tr.querySelector(".del-row").addEventListener("click", () => {
      state.forbidden.splice(idx, 1);
      invalidateResult();
      renderForbidden();
    });
    tbody.appendChild(tr);
  });
}

// ---------------- 结果渲染 ----------------
function statusInfo(result) {
  switch (result.status) {
    case "OPTIMAL":
      return { cls: "optimal", text: "已证最优" };
    case "FEASIBLE":
      return { cls: "feasible", text: "找到可行解（未证最优）" };
    case "INFEASIBLE":
      return { cls: "fail", text: "无可行解" };
    case "LOCKED_CONFLICT":
      return { cls: "fail", text: "锁定集合冲突" };
    case "MODEL_INVALID":
      return { cls: "fail", text: "模型无效" };
    default:
      return { cls: "fail", text: "时限内未找到解" };
  }
}

function renderResult() {
  const card = $("#resultCard");
  const r = state.result;
  if (!r) { card.hidden = true; drawSpectrum(); return; }
  card.hidden = false;

  const info = statusInfo(r);
  const badge = $("#statusBadge");
  badge.className = `badge ${info.cls}`;
  badge.textContent = info.text;

  if (r.feasible) {
    $("#solveMeta").textContent =
      `已分配 ${r.assigned_count} 台 ｜ 现用频点变更 ${r.changed_count} 台 ｜ ` +
      `耗时 ${(r.wall_time).toFixed(2)} 秒` +
      (r.optimal ? "" : " ｜ 未在时限内证明最优，当前为可行解");
  } else if (r.status === "LOCKED_CONFLICT") {
    $("#solveMeta").textContent = "锁定设备的固定频点之间已存在冲突，未执行求解。";
  } else {
    $("#solveMeta").textContent =
      `求解器状态：${info.text}（耗时 ${(r.wall_time || 0).toFixed(2)} 秒）`;
  }

  const conflictBox = $("#conflictBox");
  if (r.locked_conflicts && r.locked_conflicts.length) {
    conflictBox.hidden = false;
    const ul = $("#conflictList");
    ul.innerHTML = "";
    r.locked_conflicts.forEach((c) => {
      const li = document.createElement("li");
      li.textContent = `冲突设备：${c.devices.join("、")} ｜ 规则：${ruleText(c.rule)} ｜ ${c.detail}`;
      ul.appendChild(li);
    });
  } else {
    conflictBox.hidden = true;
  }

  $("#resultTableWrap").hidden = !(r.feasible);
  const tbody = $("#resultTbody");
  tbody.innerHTML = "";
  (r.devices || []).forEach((d) => {
    const tr = document.createElement("tr");
    if (!d.assigned) tr.classList.add("unassigned");
    tr.innerHTML = `
      <td class="col-id">${d.id}</td>
      <td class="col-name">${escapeAttr(d.name) || "—"}</td>
      <td>${d.locked ? '<span class="locked-tag">锁定</span>' : ""}</td>
      <td>${d.current == null ? "—" : d.current}</td>
      <td>${d.assigned
        ? `<span class="freq-cell">${d.frequency}</span>` +
          (d.changed ? '<span class="changed-tag">已变更</span>' : "")
        : '<span class="unassigned">未分配</span>'}</td>
      <td>${d.assigned ? "已分配" : '<span class="unassigned">未分配</span>'}</td>`;
    tbody.appendChild(tr);
  });

  drawSpectrum();
}

function ruleText(rule) {
  return {
    locked_forbidden: "锁定频点禁用冲突",
    min_gap: "最小频差规则",
    imd: "三阶互调规则",
  }[rule] || rule;
}

// ---------------- 频谱视图 ----------------
function drawSpectrum() {
  const canvas = $("#spectrum");
  const plan = currentPlanOrNull();
  if (!plan) { canvas.style.display = "none"; return; }
  canvas.style.display = "block";

  const d = plan.settings.min_gap || 0;
  const allFreqs = plan.devices.flatMap((dev) => dev.candidates);
  plan.forbidden.forEach((f) => { allFreqs.push(f.lo, f.hi); });
  if (!allFreqs.length) { canvas.width = 1; canvas.height = 1; return; }

  let lo = Math.min(...allFreqs);
  let hi = Math.max(...allFreqs);
  // 留出 ±d 保护带的显示余量
  lo = Math.max(1, lo - d);
  hi = hi + d;
  const span = Math.max(1, hi - lo);
  lo -= Math.ceil(span * 0.03);
  hi += Math.ceil(span * 0.03);

  const padL = 70, padR = 20, padT = 14, axisH = 26;
  const laneH = 42;
  const rows = plan.devices.length;
  const W = Math.max(720, canvas.clientWidth || 960);
  const H = padT + axisH + rows * laneH + 10;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.height = H + "px";
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const xOf = (f) => padL + (f - lo) / (hi - lo) * (W - padL - padR);

  // 背景
  ctx.fillStyle = "#0b1220";
  ctx.fillRect(0, 0, W, H);

  // 禁用区间（全屏高度带）
  plan.forbidden.forEach((seg) => {
    const x1 = xOf(seg.lo), x2 = xOf(seg.hi);
    ctx.fillStyle = "rgba(185,28,28,.28)";
    ctx.fillRect(x1, padT, Math.max(2, x2 - x1), H - padT - 10);
    ctx.strokeStyle = "#b91c1c";
    ctx.setLineDash([4, 3]);
    ctx.strokeRect(x1, padT, Math.max(2, x2 - x1), H - padT - 10);
    ctx.setLineDash([]);
  });

  // 频率轴
  ctx.strokeStyle = "#475569";
  ctx.beginPath();
  ctx.moveTo(padL, padT + axisH);
  ctx.lineTo(W - padR, padT + axisH);
  ctx.stroke();
  ctx.fillStyle = "#94a3b8";
  ctx.font = "11px sans-serif";
  ctx.textAlign = "center";
  const ticks = niceTicks(lo, hi, 8);
  ticks.forEach((t) => {
    if (t < lo || t > hi) return;
    const x = xOf(t);
    ctx.beginPath();
    ctx.moveTo(x, padT + axisH);
    ctx.lineTo(x, padT + axisH + 5);
    ctx.strokeStyle = "#475569";
    ctx.stroke();
    ctx.fillText(`${t}`, x, padT + axisH + 18);
    ctx.strokeStyle = "rgba(71,85,105,.35)";
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, padT + axisH);
    ctx.stroke();
  });

  // 每个设备一行
  const assignedMap = new Map();
  if (state.result && state.result.feasible) {
    state.result.devices.forEach((rd) => {
      assignedMap.set(rd.id - 1, rd);
    });
  }

  plan.devices.forEach((dev, i) => {
    const y = padT + axisH + i * laneH + laneH / 2;
    // 行标签
    ctx.fillStyle = "#cbd5e1";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "right";
    const label = `${i + 1}${dev.name ? "·" + dev.name : ""}`;
    ctx.fillText(truncate(label, 10), padL - 8, y + 4);
    // 行底线
    ctx.strokeStyle = "rgba(51,65,85,.7)";
    ctx.beginPath();
    ctx.moveTo(padL, y + laneH / 2 - 4);
    ctx.lineTo(W - padR, y + laneH / 2 - 4);
    ctx.stroke();

    const rd = assignedMap.get(i);
    const assignedFreq = rd && rd.assigned ? rd.frequency : null;

    // ±d 保护带
    if (assignedFreq != null) {
      ctx.fillStyle = "rgba(34,211,238,.18)";
      ctx.fillRect(xOf(assignedFreq - d), y - 13,
        Math.max(2, xOf(assignedFreq + d) - xOf(assignedFreq - d)), 26);
    }
    // 候选频点
    dev.candidates.forEach((f) => {
      const forbidden = plan.forbidden.some((s) => s.lo <= f && f <= s.hi);
      ctx.beginPath();
      ctx.arc(xOf(f), y, 4, 0, Math.PI * 2);
      if (forbidden) {
        ctx.fillStyle = "#dc2626";
      } else {
        ctx.fillStyle = "#64748b";
      }
      ctx.fill();
    });
    // 现用频点（橙色方块）
    if (dev.current != null) {
      ctx.fillStyle = "#f59e0b";
      ctx.fillRect(xOf(dev.current) - 4, y + 6, 8, 8);
    }
    // 已分配（青色菱形，置于最上层）
    if (assignedFreq != null) {
      const x = xOf(assignedFreq);
      ctx.fillStyle = "#22d3ee";
      ctx.beginPath();
      ctx.moveTo(x, y - 9);
      ctx.lineTo(x + 8, y);
      ctx.lineTo(x, y + 9);
      ctx.lineTo(x - 8, y);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "#0b1220";
      ctx.font = "bold 10px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(String(assignedFreq), x, y - 13);
    }
  });
}

function currentPlanOrNull() {
  // 频谱只需要可绘制的数值，忽略校验错误
  const devices = state.devices.map((d) => ({
    name: d.name,
    candidates: parseCandidates(d.candidatesText)
      .filter((v) => Number.isInteger(v) && v > 0),
    current: d.current === "" || d.current == null ? null : Number(d.current),
    locked: d.locked,
  }));
  if (!devices.length) return null;
  const forbidden = state.forbidden
    .map((f) => ({ lo: Number(f.lo), hi: Number(f.hi) }))
    .filter((f) => Number.isInteger(f.lo) && Number.isInteger(f.hi));
  return {
    devices,
    forbidden,
    settings: { min_gap: Number($("#minGap").value) || 0 },
  };
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function niceTicks(lo, hi, target) {
  const span = hi - lo;
  const raw = span / Math.max(1, target);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const start = Math.ceil(lo / step) * step;
  const ticks = [];
  for (let v = start; v <= hi; v += step) ticks.push(Math.round(v));
  return ticks;
}

// ---------------- API ----------------
async function api(path, opts = {}) {
  const resp = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (!resp.ok) {
    let detail;
    try {
      const body = await resp.json();
      detail = formatValidation(body.detail);
    } catch {
      detail = `HTTP ${resp.status}`;
    }
    throw new Error(detail);
  }
  return resp.json();
}

function formatValidation(detail) {
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail.map((e) => {
      const loc = (e.loc || []).filter((p) => p !== "body").join(".");
      return `${loc ? loc + ": " : ""}${e.msg}`;
    }).join("\n");
  }
  return JSON.stringify(detail);
}

async function refreshSavedList(selectId) {
  const plans = await api("/api/plans");
  const sel = $("#savedSelect");
  sel.innerHTML = '<option value="">— 打开已保存方案 —</option>';
  plans.forEach((p) => {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = `${p.name}（#${p.id}）`;
    sel.appendChild(opt);
  });
  if (selectId != null) sel.value = String(selectId);
}

function loadPlanIntoState(saved) {
  state.planId = saved.id;
  state.result = saved.last_result || null;
  $("#planName").value = saved.data.name;
  state.devices = saved.data.devices.map((d) => ({
    name: d.name,
    candidatesText: d.candidates.join(" "),
    current: d.current == null ? "" : String(d.current),
    locked: d.locked,
  }));
  state.forbidden = (saved.data.forbidden || []).map((f) => ({
    lo: String(f.lo), hi: String(f.hi),
  }));
  $("#minGap").value = saved.data.settings.min_gap;
  $("#imdTol").value = saved.data.settings.imd_tolerance;
  $("#timeLimit").value = saved.data.settings.time_limit;
  renderDevices();
  renderForbidden();
  renderResult();
}

// ---------------- 事件 ----------------
$("#btnAddDevice").addEventListener("click", () => {
  if (state.devices.length >= 8) return;
  state.devices.push({
    name: "", candidatesText: "", current: "", locked: false,
  });
  invalidateResult();
  renderDevices();
});

$("#btnAddForbidden").addEventListener("click", () => {
  state.forbidden.push({ lo: "", hi: "" });
  invalidateResult();
  renderForbidden();
});

$("#btnNew").addEventListener("click", () => {
  if (!confirm("放弃当前编辑并新建空白方案？")) return;
  state.planId = null;
  state.result = null;
  $("#savedSelect").value = "";
  initDefault(true);
});

$("#btnSave").addEventListener("click", async () => {
  $("#formError").textContent = "";
  const { errs, plan } = buildPlan();
  markInvalidRows();
  if (errs.length) {
    $("#formError").textContent = "⚠ " + errs.join("；");
    return;
  }
  try {
    let saved;
    if (state.planId) {
      saved = await api(`/api/plans/${state.planId}`, {
        method: "PUT", body: JSON.stringify(plan),
      });
    } else {
      saved = await api("/api/plans", {
        method: "POST", body: JSON.stringify(plan),
      });
      state.planId = saved.id;
    }
    $("#formError").textContent = `✓ 方案已保存（#${saved.id}）`;
    await refreshSavedList(saved.id);
  } catch (e) {
    $("#formError").textContent = "⚠ " + e.message;
  }
});

$("#savedSelect").addEventListener("change", async () => {
  const id = $("#savedSelect").value;
  if (!id) return;
  try {
    const saved = await api(`/api/plans/${id}`);
    loadPlanIntoState(saved);
  } catch (e) {
    alert(e.message);
  }
});

$("#btnDelete").addEventListener("click", async () => {
  const id = $("#savedSelect").value;
  if (!id) { alert("请先在右侧下拉框选择要删除的方案"); return; }
  if (!confirm(`确定删除方案 #${id}？此操作不可恢复。`)) return;
  try {
    await api(`/api/plans/${id}`, { method: "DELETE" });
    if (state.planId === Number(id)) {
      state.planId = null;
      state.result = null;
      initDefault(true);
    }
    await refreshSavedList();
  } catch (e) {
    alert(e.message);
  }
});

$("#btnSolve").addEventListener("click", async () => {
  $("#formError").textContent = "";
  const { errs, plan } = buildPlan();
  markInvalidRows();
  if (errs.length) {
    $("#formError").textContent = "⚠ " + errs.join("；");
    return;
  }
  const btn = $("#btnSolve");
  btn.disabled = true;
  btn.textContent = "求解中…";
  try {
    let result;
    if (state.planId) {
      // 先以界面最新内容覆盖保存，再调用保存方案求解，保证结果与方案一同持久化
      await api(`/api/plans/${state.planId}`, {
        method: "PUT", body: JSON.stringify(plan),
      });
      result = await api(`/api/plans/${state.planId}/solve`, { method: "POST" });
    } else {
      result = await api("/api/solve", {
        method: "POST", body: JSON.stringify(plan),
      });
    }
    state.result = result;
    renderResult();
    await refreshSavedList(state.planId);
  } catch (e) {
    $("#formError").textContent = "⚠ " + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "▶ 协调求解";
  }
});

window.addEventListener("resize", drawSpectrum);
["#minGap", "#imdTol"].forEach((sel) => {
  $(sel).addEventListener("input", () => { drawSpectrum(); invalidateResult(); });
});

// ---------------- 初始示例 ----------------
function initDefault(blank) {
  $("#planName").value = "";
  state.devices = blank ? [
    { name: "", candidatesText: "", current: "", locked: false },
    { name: "", candidatesText: "", current: "", locked: false },
  ] : [];
  state.forbidden = [];
  state.result = null;
  if (blank) {
    $("#minGap").value = 100;
    $("#imdTol").value = 200;
    $("#timeLimit").value = 10;
  }
  renderDevices();
  renderForbidden();
  renderResult();
}

async function boot() {
  initDefault(false);
  // 预置一组便于直接体验的示例
  const demo = [
    { name: "主唱麦", candidatesText: "600000 600400 600800 601200 601600", current: "600000", locked: true },
    { name: "和声麦", candidatesText: "600200 600600 601000 601400 601800", current: "600600", locked: false },
    { name: "主持麦", candidatesText: "600300 600700 601100 601500 601900", current: "", locked: false },
    { name: "嘉宾麦", candidatesText: "600500 600900 601300 601700 602100", current: "", locked: false },
  ];
  state.devices = demo;
  state.forbidden = [{ lo: "601000", hi: "601100" }];
  $("#planName").value = "示例演出方案";
  $("#minGap").value = 300;
  $("#imdTol").value = 200;
  $("#timeLimit").value = 10;
  renderDevices();
  renderForbidden();
  renderResult();

  await refreshSavedList();
}

boot();
