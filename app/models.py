"""无线话筒频点协调台 —— 数据模型与入参校验。"""
from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field, model_validator


class DeviceIn(BaseModel):
    """一支话筒的录入信息。设备 ID 由其在方案中的位置（从 1 开始）确定。"""

    name: str = Field("", max_length=64, description="设备名称（可选）")
    candidates: list[int] = Field(
        ..., description="1~12 个互异正整数 kHz 候选频点"
    )
    current: Optional[int] = Field(
        None, description="可选现用频点（若给出必须属于候选频点）"
    )
    locked: bool = Field(False, description="锁定标志：锁定设备必须保留现用频点")

    @model_validator(mode="after")
    def _check(self) -> "DeviceIn":
        if not (1 <= len(self.candidates) <= 12):
            raise ValueError("每支话筒须提供 1～12 个候选频点")
        if any(f <= 0 for f in self.candidates):
            raise ValueError("候选频点必须为正整数（kHz）")
        if len(set(self.candidates)) != len(self.candidates):
            raise ValueError("同一设备的候选频点必须互异")
        if self.current is not None and self.current not in self.candidates:
            raise ValueError("现用频点必须属于该设备的候选频点")
        if self.locked and self.current is None:
            raise ValueError("锁定设备必须设置现用频点")
        return self


class ForbiddenIntervalIn(BaseModel):
    """禁用闭区间 [lo, hi]，单位 kHz。"""

    lo: int = Field(..., gt=0)
    hi: int = Field(..., gt=0)

    @model_validator(mode="after")
    def _check(self) -> "ForbiddenIntervalIn":
        if self.lo > self.hi:
            raise ValueError("禁用区间起点不得大于终点")
        return self


class SettingsIn(BaseModel):
    """方案级约束与求解参数。"""

    min_gap: int = Field(..., gt=0, description="正整数最小频差 d（kHz）")
    imd_tolerance: int = Field(..., ge=0, description="非负互调容差 g（kHz）")
    time_limit: int = Field(..., gt=0, description="正整数求解时限（秒）")


class PlanIn(BaseModel):
    """完整演出方案。"""

    name: str = Field(..., min_length=1, max_length=128)
    devices: list[DeviceIn] = Field(...)
    forbidden: list[ForbiddenIntervalIn] = Field(default_factory=list)
    settings: SettingsIn

    @model_validator(mode="after")
    def _check(self) -> "PlanIn":
        if not (2 <= len(self.devices) <= 8):
            raise ValueError("一个演出方案须包含 2～8 支话筒")
        return self


class DeviceOut(BaseModel):
    id: int
    name: str
    candidates: list[int]
    current: Optional[int] = None
    locked: bool
    assigned: bool
    frequency: Optional[int] = None
    changed: bool = False


class ConflictOut(BaseModel):
    rule: str
    devices: list[int]
    detail: str


class SolveResultOut(BaseModel):
    feasible: bool
    optimal: bool
    status: str
    wall_time: float
    objective: Optional[int] = None
    assigned_count: int = 0
    changed_count: int = 0
    devices: list[DeviceOut] = Field(default_factory=list)
    locked_conflicts: list[ConflictOut] = Field(default_factory=list)


class PlanOut(BaseModel):
    id: int
    name: str
    data: PlanIn
    created_at: str
    updated_at: str
    last_result: Optional[SolveResultOut] = None
