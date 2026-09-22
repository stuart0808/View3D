#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
survey.py —— 实地标注数据（前端 survey.html 采集）的合并与回写。

标注数据格式（前端 src/survey/model.js 生成）:
    {
      "version": 1, "scene": "imported/xxx",
      "cells": {"B03": {"status": "done", "by": "张三", "t": 毫秒时间戳}},
      "shops": [{"id": "s...", "building": "b12", "name", "category", "floor", "hours", "note", "cell",
                 "doors": [{"pos": [x, y], "normal": [nx, ny]}], "frontage": [[x, y], ...], "frontageLen",
                 "deleted": 可选, "by", "t"}],
      "log": [{"t", "by", "action", "id"}]
    }
坐标是场景米（和 scene.json 同一套）。

merge(a, b)            几台手机的数据合并: 商户 / 格子按编号取较新的一份（删除也是一次「更新」），日志取并集
apply_survey(scene, s) 把实测结果写回场景: 标过门的楼换成实测的门，吸引力按业态汇总，楼上记商户清单
"""
import copy
import time

# 业态 → 吸引力权重；必须和 src/survey/model.js 的 CATEGORIES 一致（tests/py/test_survey.py 会比对）
CAT_W = {"food": 1.6, "retail": 1.2, "service": 0.8, "fun": 1.4, "office": 0.5, "other": 0.6, "vacant": 0.0}
LOG_MAX = 20000  # 日志最多留这么多条（最新的），防止文件无限长


def empty(scene):
    """空白标注数据"""
    return {"version": 1, "scene": scene, "cells": {}, "shops": [], "log": []}


def _newer(a, b):
    """两份同编号的记录取较新的（t 大的）；一样新时取 b（后到的那份）"""
    if a is None:
        return b
    if b is None:
        return a
    return b if b.get("t", 0) >= a.get("t", 0) else a


def merge(a, b):
    """
    合并两份标注数据（服务器上存的 a + 手机传上来的 b）

    规则是「按记录的最后修改时间取新」: 不同人标不同的店互不影响；同一家店两个人都改了，
    后改的赢。删除带墓碑（deleted = true）也有时间戳，所以删除能同步到别的手机，
    又不会被旧数据「复活」。
    Returns:
        新的 dict，不改 a / b
    """
    a, b = a or {}, b or {}
    shops = {}
    for s in a.get("shops", []) + b.get("shops", []):  # 先 a 后 b: 同样新时 b 赢
        shops[s["id"]] = _newer(shops.get(s["id"]), s)
    cells = dict(a.get("cells", {}))
    for k, v in b.get("cells", {}).items():
        cells[k] = _newer(cells.get(k), v)
    # 日志按 (时间, 人, 动作, 对象) 去重后按时间排，只留最新的 LOG_MAX 条
    seen, log = set(), []
    for e in a.get("log", []) + b.get("log", []):
        key = (e.get("t"), e.get("by"), e.get("action"), e.get("id"))
        if key not in seen:
            seen.add(key)
            log.append(e)
    log.sort(key=lambda e: e.get("t", 0))
    return {"version": 1, "scene": b.get("scene") or a.get("scene"), "cells": cells,
            "shops": sorted(shops.values(), key=lambda s: s.get("t", 0)), "log": log[-LOG_MAX:]}


def apply_survey(scene, survey):
    """
    把实测商户写回场景（返回新场景，不改传进来的 scene）

    - 标了商户的楼: 自动生成的门全部换成实测的门（有门的商户才算；一扇都没标的楼保留原来的门）；
      门离得不到 0.5 米的算同一扇
    - 吸引力 attraction = 该楼各商户业态权重之和（至少 0，全空置就是 0: 仿真里没人专门去）
    - 楼上加 shops: [{id, name, category, floor}]，点楼时可以显示
    - 场景加 survey: {shops, buildings, applied}，并记 surveyOf = 标注数据对应的场景 id
    Returns:
        新的 scene dict
    """
    out = copy.deepcopy(scene)
    ids = {b["id"] for b in out.get("buildings", [])}
    by_b = {}
    for s in survey.get("shops", []):
        if s.get("deleted") or s.get("building") not in ids:
            continue  # 删掉的 / 楼已经不在场景里的（场景重新生成过）跳过
        by_b.setdefault(s["building"], []).append(s)
    new_doors = {}  # 楼 id → 实测的门
    for bid, shops in by_b.items():
        doors = []
        for s in shops:
            for d in s.get("doors") or []:
                if all((d["pos"][0] - e["pos"][0]) ** 2 + (d["pos"][1] - e["pos"][1]) ** 2 >= 0.25 for e in doors):
                    doors.append({"building": bid, "pos": list(d["pos"]), "normal": list(d["normal"])})
        if doors:
            new_doors[bid] = doors
    # 被替换的楼先把旧门去掉，再按原来的顺序追加实测的门
    out["doors"] = [d for d in out.get("doors", []) if d.get("building") not in new_doors]
    for bid in sorted(new_doors):
        out["doors"].extend(new_doors[bid])
    for b in out.get("buildings", []):
        shops = by_b.get(b["id"])
        if not shops:
            continue
        b["attraction"] = round(max(0.0, sum(CAT_W.get(s.get("category"), 0.6) for s in shops)), 2)  # 不认识的业态按「其他」
        b["shops"] = [{"id": s["id"], "name": s.get("name", ""), "category": s.get("category", ""), "floor": s.get("floor", "")} for s in shops]
    out["survey"] = {"shops": sum(len(v) for v in by_b.values()), "buildings": len(by_b), "applied": time.strftime("%Y-%m-%d %H:%M:%S")}
    out["surveyOf"] = scene.get("surveyOf") or survey.get("scene")  # 对已回写的场景再回写，仍指向最初那份标注
    return out
