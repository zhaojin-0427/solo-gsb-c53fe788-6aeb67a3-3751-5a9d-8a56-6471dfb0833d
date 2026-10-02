"""FastAPI 入口：方案 CRUD、求解接口，并托管前端静态页面。"""
from __future__ import annotations

import os

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import db
from .models import PlanIn, PlanOut, SolveResultOut
from .solver import solve

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")

app = FastAPI(title="无线话筒频点协调台", version="1.0.0")


@app.on_event("startup")
def _startup() -> None:
    db.init_db()


# ---------------- 方案管理 ----------------

@app.get("/api/plans")
def api_list_plans() -> list[dict]:
    return db.list_plans()


@app.post("/api/plans", response_model=PlanOut)
def api_create_plan(plan: PlanIn) -> dict:
    return db.create_plan(plan.name, plan.model_dump())


@app.get("/api/plans/{plan_id}", response_model=PlanOut)
def api_get_plan(plan_id: int) -> dict:
    row = db.get_plan(plan_id)
    if row is None:
        raise HTTPException(status_code=404, detail="方案不存在")
    return row


@app.put("/api/plans/{plan_id}", response_model=PlanOut)
def api_update_plan(plan_id: int, plan: PlanIn) -> dict:
    row = db.update_plan(plan_id, plan.name, plan.model_dump())
    if row is None:
        raise HTTPException(status_code=404, detail="方案不存在")
    return row


@app.delete("/api/plans/{plan_id}")
def api_delete_plan(plan_id: int) -> dict:
    if not db.delete_plan(plan_id):
        raise HTTPException(status_code=404, detail="方案不存在")
    return {"ok": True}


# ---------------- 求解 ----------------

@app.post("/api/plans/{plan_id}/solve", response_model=SolveResultOut)
def api_solve_saved(plan_id: int) -> dict:
    row = db.get_plan(plan_id)
    if row is None:
        raise HTTPException(status_code=404, detail="方案不存在")
    plan = PlanIn.model_validate(row["data"])
    result = solve(plan)
    db.set_result(plan_id, result)
    return result


@app.post("/api/solve", response_model=SolveResultOut)
def api_solve_adhoc(plan: PlanIn) -> dict:
    """对当前界面中的方案直接求解（无需先保存）。"""
    return solve(plan)


# ---------------- 前端静态页面 ----------------

@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")
