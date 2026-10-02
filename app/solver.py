"""频点协调求解器（OR-Tools CP-SAT）。

约束：
  * 锁定设备保留现用频点；
  * 任意两支配频设备频差绝对值 >= d；
  * 任意互异三支 i,j,k，|2*fi - fj - fk| > g（需三支均已分配）；
  * 禁用闭区间内频点不得使用；
  * 允许未分配。

目标（字典序）：
  1) 最大化已分配台数；
  2) 最小化已分配设备的现用频点变更台数；
  3) 按设备 ID 升序取频点序列最小（未分配视为大于所有候选频点）。

实现上把三级字典序合并为单个加权和最小化目标（权重逐级严格占优）。
若锁定设备集合本身已冲突，则不启动求解，直接返回冲突明细。
"""
from __future__ import annotations

from itertools import combinations
from typing import Any

from ortools.sat.python import cp_model

from .models import PlanIn

# 状态码到中文文案
STATUS_TEXT = {
    "OPTIMAL": "已证最优",
    "FEASIBLE": "找到可行解（未证最优）",
    "INFEASIBLE": "无可行解",
    "MODEL_INVALID": "模型无效",
    "UNKNOWN": "时限内未找到解",
}


def _in_forbidden(f: int, forbidden: list) -> bool:
    return any(seg.lo <= f <= seg.hi for seg in forbidden)


def find_locked_conflicts(plan: PlanIn) -> list[dict[str, Any]]:
    """检查锁定设备固定频点之间的冲突（求解前的硬冲突）。"""
    conflicts: list[dict[str, Any]] = []
    locked = [
        (idx + 1, dev.current)
        for idx, dev in enumerate(plan.devices)
        if dev.locked
    ]
    d = plan.settings.min_gap
    g = plan.settings.imd_tolerance

    # 规则 1：现用频点落在禁用区间
    for dev_id, f in locked:
        segs = [f"[{s.lo}, {s.hi}]" for s in plan.forbidden if s.lo <= f <= s.hi]
        if segs:
            conflicts.append({
                "rule": "locked_forbidden",
                "devices": [dev_id],
                "detail": f"设备 {dev_id} 锁定频点 {f} kHz 落入禁用闭区间 "
                          f"{'、'.join(segs)}，禁止使用",
            })

    # 规则 2：两支锁定设备频差不足 d
    for (i, fi), (j, fj) in combinations(locked, 2):
        if abs(fi - fj) < d:
            conflicts.append({
                "rule": "min_gap",
                "devices": [i, j],
                "detail": f"锁定设备 {i}、{j} 频点为 {fi}、{fj} kHz，"
                          f"频差 {abs(fi - fj)} kHz 小于最小频差 d={d} kHz",
            })

    # 规则 3：三支锁定设备违反互调容差 |2fi - fj - fk| <= g
    # i 为互调中心（被 2 倍的频点），j<k 为另两支；覆盖所有互异三元组。
    locked_ids = [dev_id for dev_id, _ in locked]
    freq = dict(locked)
    for (i, j, k) in combinations(locked_ids, 3):
        for center, a, b in ((i, j, k), (j, i, k), (k, i, j)):
            v = abs(2 * freq[center] - freq[a] - freq[b])
            if v <= g:
                conflicts.append({
                    "rule": "imd",
                    "devices": [center, a, b],
                    "detail": f"锁定设备 {center}、{a}、{b} 频点为 "
                              f"{freq[center]}、{freq[a]}、{freq[b]} kHz，"
                              f"|2f{center}−f{a}−f{b}|={v} kHz 未超过互调容差 "
                              f"g={g} kHz",
                })
    return conflicts


def solve(plan: PlanIn) -> dict[str, Any]:
    """构建并求解模型，返回可序列化的结果字典。"""
    n = len(plan.devices)
    d = plan.settings.min_gap
    g = plan.settings.imd_tolerance
    time_limit = plan.settings.time_limit

    locked_conflicts = find_locked_conflicts(plan)
    if locked_conflicts:
        return {
            "feasible": False,
            "optimal": False,
            "status": "LOCKED_CONFLICT",
            "wall_time": 0.0,
            "objective": None,
            "assigned_count": 0,
            "changed_count": 0,
            "devices": [],
            "locked_conflicts": locked_conflicts,
        }

    model = cp_model.CpModel()

    # 候选频点（剔除禁用区间并升序排列；锁定频点的禁用冲突已在前面拦截）。
    # 升序排列使 rank 序与频点数值序一致，从而第三级目标等价于频点序列字典序最小。
    allowed: list[list[int]] = [
        sorted(f for f in dev.candidates if not _in_forbidden(f, plan.forbidden))
        for dev in plan.devices
    ]

    max_f = max(f for dev in plan.devices for f in dev.candidates)
    M = max_f + 1  # 未分配哨兵：大于所有候选频点

    # ---- 变量 ----
    # x[i]：设备 i 的频点；未分配时取哨兵 M。
    # rank[i]：频点在候选列表中的序号（0..len-1），未分配取 len。
    x: list[cp_model.IntVar] = []
    rank: list[cp_model.IntVar] = []
    assigned: list[cp_model.IntVar] = []  # 0/1 布尔
    changed: list[cp_model.IntVar] = []   # 0/1：已分配且偏离现用频点

    for i, dev in enumerate(plan.devices):
        cand = allowed[i]
        m = len(cand)
        rdom = list(range(m + 1))
        r = model.new_int_var_from_domain(
            cp_model.Domain.from_values(rdom), f"rank_{i+1}"
        )
        xvar = model.new_int_var_from_domain(
            cp_model.Domain.from_values(cand + [M]), f"x_{i+1}"
        )
        a = model.new_bool_var(f"assigned_{i+1}")
        ch = model.new_bool_var(f"changed_{i+1}")
        rank.append(r)
        x.append(xvar)
        assigned.append(a)
        changed.append(ch)

        # 未分配 <=> rank 取末位序号 m <=> x=M
        model.add(r == m).only_enforce_if(a.Not())
        model.add(r < m).only_enforce_if(a)
        model.add(xvar == M).only_enforce_if(a.Not())

        # rank -> x 的映射（已分配时 rank 即升序候选中的下标）
        for ri, f in enumerate(cand):
            lit = model.new_bool_var(f"r{i+1}_{ri}")
            model.add(r == ri).only_enforce_if(lit)
            model.add(r != ri).only_enforce_if(lit.Not())
            model.add(xvar == f).only_enforce_if([a, lit])

        # 锁定设备：必须分配且保留现用频点（Pydantic 已保证 current 在候选中）
        if dev.locked:
            model.add(a == 1)
            model.add(xvar == dev.current)
            model.add(ch == 0)
        else:
            if dev.current is None:
                # 无现用频点的设备不存在“变更”概念，恒为 0
                model.add(ch == 0)
            else:
                # changed = a AND (x != current)；未分配时 x=M，自然 != current
                eq = model.new_bool_var(f"eqcur_{i+1}")
                model.add(xvar == dev.current).only_enforce_if(eq)
                model.add(xvar != dev.current).only_enforce_if(eq.Not())
                model.add_bool_and(a, eq.Not()).only_enforce_if(ch)
                model.add_bool_or(a.Not(), eq).only_enforce_if(ch.Not())

    # ---- 任意两支已分配设备：|fi - fj| >= d ----
    # 未分配设备取哨兵 M，两支未分配设备同为 M（差为 0），因此差值约束
    # 必须仅在“两支均已分配”时生效：
    for i in range(n):
        for j in range(i + 1, n):
            both = [assigned[i], assigned[j]]
            ge = model.new_bool_var(f"order_{i+1}_{j+1}")
            model.add(x[i] - x[j] >= d).only_enforce_if([ge, *both])
            model.add(x[j] - x[i] >= d).only_enforce_if([ge.Not(), *both])

    # ---- 任意互异三支：|2fi - fj - fk| > g（三支均已分配时）----
    for (i, j, k) in combinations(range(n), 3):
        all3 = [assigned[i], assigned[j], assigned[k]]
        # 2*x[i] - x[j] - x[k] > g  或 < -g，三个中心位置都要覆盖
        for center, a_idx, b_idx in ((i, j, k), (j, i, k), (k, i, j)):
            pos = model.new_bool_var(f"imd_p_{center+1}_{a_idx+1}_{b_idx+1}")
            model.add(
                2 * x[center] - x[a_idx] - x[b_idx] >= g + 1
            ).only_enforce_if([pos, *all3])
            model.add(
                2 * x[center] - x[a_idx] - x[b_idx] <= -(g + 1)
            ).only_enforce_if([pos.Not(), *all3])

    # ---- 目标：三级字典序 ----
    # 第三级：频点序列 (rank_1, ..., rank_n) 的字典序最小，rank ∈ 0..12，
    # 未分配取 m_i（候选个数，≤12，即“大于所有候选频点”）。
    # 以 13 为底做位置加权即可精确编码字典序：
    lex_weights = [13 ** (n - 1 - i) for i in range(n)]
    max_lex = 13 ** n - 1  # rank ≤ 12 时加权和的上界
    # K2 严格大于第三级任意差值；K1 再严格大于第二、三级任意差值之和。
    K2 = max_lex + 1
    K1 = n * K2 + max_lex + 1
    model.minimize(
        -K1 * sum(assigned)
        + K2 * sum(changed)
        + sum(w * r for w, r in zip(lex_weights, rank))
    )

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = float(time_limit)
    solver.parameters.num_search_workers = 8
    status = solver.solve(model)

    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        code = {
            cp_model.INFEASIBLE: "INFEASIBLE",
            cp_model.MODEL_INVALID: "MODEL_INVALID",
        }.get(status, "UNKNOWN")
        return {
            "feasible": False,
            "optimal": False,
            "status": code,
            "wall_time": solver.wall_time,
            "objective": None,
            "assigned_count": 0,
            "changed_count": 0,
            "devices": [],
            "locked_conflicts": [],
        }

    devices_out: list[dict[str, Any]] = []
    assigned_count = 0
    changed_count = 0
    for i, dev in enumerate(plan.devices):
        is_assigned = solver.value(assigned[i]) == 1
        freq = solver.value(x[i]) if is_assigned else None
        ch = solver.value(changed[i]) == 1
        if is_assigned:
            assigned_count += 1
        if ch:
            changed_count += 1
        devices_out.append({
            "id": i + 1,
            "name": dev.name,
            "candidates": list(dev.candidates),
            "current": dev.current,
            "locked": dev.locked,
            "assigned": is_assigned,
            "frequency": freq,
            "changed": ch,
        })

    return {
        "feasible": True,
        "optimal": status == cp_model.OPTIMAL,
        "status": "OPTIMAL" if status == cp_model.OPTIMAL else "FEASIBLE",
        "wall_time": solver.wall_time,
        "objective": solver.objective_value,
        "assigned_count": assigned_count,
        "changed_count": changed_count,
        "devices": devices_out,
        "locked_conflicts": [],
    }
