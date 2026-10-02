"""SQLite 存储层：方案与最近一次求解结果以 JSON 持久化。"""
from __future__ import annotations

import json
import os
import sqlite3
import time
from contextlib import contextmanager
from typing import Any, Iterator, Optional

DB_PATH = os.environ.get("DB_PATH", "/data/plans.db")

_SCHEMA = """
CREATE TABLE IF NOT EXISTS plans (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    data       TEXT NOT NULL,
    last_result TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"""


def _ensure_parent() -> None:
    parent = os.path.dirname(DB_PATH)
    if parent:
        os.makedirs(parent, exist_ok=True)


@contextmanager
def get_conn() -> Iterator[sqlite3.Connection]:
    _ensure_parent()
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db() -> None:
    with get_conn() as conn:
        conn.executescript(_SCHEMA)


def _row_to_dict(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "name": row["name"],
        "data": json.loads(row["data"]),
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "last_result": json.loads(row["last_result"]) if row["last_result"] else None,
    }


def list_plans() -> list[dict[str, Any]]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM plans ORDER BY updated_at DESC, id DESC"
        ).fetchall()
        return [_row_to_dict(r) for r in rows]


def get_plan(plan_id: int) -> Optional[dict[str, Any]]:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM plans WHERE id = ?", (plan_id,)
        ).fetchone()
        return _row_to_dict(row) if row else None


def create_plan(name: str, data: dict[str, Any]) -> dict[str, Any]:
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO plans (name, data, last_result, created_at, updated_at) "
            "VALUES (?, ?, NULL, ?, ?)",
            (name, json.dumps(data, ensure_ascii=False), now, now),
        )
        plan_id = cur.lastrowid
    return get_plan(plan_id)  # type: ignore[return-value]


def update_plan(
    plan_id: int,
    name: str,
    data: dict[str, Any],
    last_result: Optional[dict[str, Any]] = None,
) -> Optional[dict[str, Any]]:
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    with get_conn() as conn:
        if last_result is None:
            cur = conn.execute(
                "UPDATE plans SET name = ?, data = ?, updated_at = ? WHERE id = ?",
                (name, json.dumps(data, ensure_ascii=False), now, plan_id),
            )
        else:
            cur = conn.execute(
                "UPDATE plans SET name = ?, data = ?, last_result = ?, "
                "updated_at = ? WHERE id = ?",
                (name, json.dumps(data, ensure_ascii=False),
                 json.dumps(last_result, ensure_ascii=False), now, plan_id),
            )
    return None if cur.rowcount == 0 else get_plan(plan_id)


def set_result(plan_id: int, result: dict[str, Any]) -> bool:
    now = time.strftime("%Y-%m-%d %H:%M:%S")
    with get_conn() as conn:
        cur = conn.execute(
            "UPDATE plans SET last_result = ?, updated_at = ? WHERE id = ?",
            (json.dumps(result, ensure_ascii=False), now, plan_id),
        )
        return cur.rowcount > 0


def delete_plan(plan_id: int) -> bool:
    with get_conn() as conn:
        cur = conn.execute("DELETE FROM plans WHERE id = ?", (plan_id,))
        return cur.rowcount > 0
