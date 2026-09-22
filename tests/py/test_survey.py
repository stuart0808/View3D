# -*- coding: utf-8 -*-
"""
实地标注数据的测试:
    survey.merge          几台手机的数据按「谁新用谁」合并，删除（墓碑）能同步，日志去重
    survey.apply_survey   实测的门替换自动生成的门，吸引力按业态汇总，楼上记商户清单
    sat_server            /api/survey 读写合并、场景 id 校验、写回生成 -surveyed 场景（不动原场景）
    和前端 src/survey/model.js 的业态权重表一致
"""
import json  # 读写场景 / 标注文件
import re  # 从前端 JS 里抠业态表
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]  # 仓库根目录
sys.path.insert(0, str(ROOT / "tools"))  # 让 import survey 找得到 tools/
import survey  # noqa: E402


def shop(sid, t, building="b1", **kw):
    """造一家商户记录: 默认在 b1 上、一扇朝下的门"""
    d = {"id": sid, "building": building, "name": sid, "category": "food", "doors": [{"pos": [5.0, 10.0], "normal": [0, 1]}], "t": t, "by": "甲"}
    d.update(kw)  # 按需覆盖默认字段
    return d


def scene():
    """两栋楼的小场景: b1 有两扇自动生成的门，b2 有一扇"""
    return {
        "buildings": [{"id": "b1", "kind": "residential", "attraction": 1.0, "polygon": [[0, 0], [20, 0], [20, 10], [0, 10]]},
                      {"id": "b2", "kind": "shop", "attraction": 1.0, "polygon": [[30, 0], [40, 0], [40, 10], [30, 10]]}],
        "doors": [{"building": "b1", "pos": [10, 0], "normal": [0, -1]}, {"building": "b1", "pos": [20, 5], "normal": [1, 0]},
                  {"building": "b2", "pos": [35, 10], "normal": [0, 1]}],
    }


# ---------------------------------------------------------------------------
# merge
# ---------------------------------------------------------------------------
def test_merge_newer_wins_and_tombstones_sync():
    """同一家店取较新的；只在一边有的都保留；删除（较新）盖过旧数据，不会被「复活」"""
    a = {"scene": "x", "shops": [shop("s1", 100, name="旧名"), shop("s2", 100)], "cells": {"A01": {"status": "doing", "t": 50}}, "log": [{"t": 100, "by": "甲", "action": "add", "id": "s1"}]}
    b = {"scene": "x", "shops": [shop("s1", 200, name="新名"), shop("s2", 300, deleted=True), shop("s3", 150)],
         "cells": {"A01": {"status": "done", "t": 40}, "B02": {"status": "done", "t": 60}},
         "log": [{"t": 100, "by": "甲", "action": "add", "id": "s1"}, {"t": 200, "by": "乙", "action": "edit", "id": "s1"}]}
    m = survey.merge(a, b)  # a 是服务器上的，b 是手机传来的
    got = {s["id"]: s for s in m["shops"]}  # 按编号索引
    assert got["s1"]["name"] == "新名"  # b 更新
    assert got["s2"]["deleted"] is True  # 删除更新 → 墓碑留下
    assert set(got) == {"s1", "s2", "s3"}  # 三家都在
    assert m["cells"]["A01"]["status"] == "doing"  # a 的更新（t=50 > 40）
    assert m["cells"]["B02"]["status"] == "done"  # 只在 b 里的格子也保留
    assert len(m["log"]) == 2  # 重复的日志只留一条
    # 反方向合并结果一样（不依赖谁先谁后，除非时间相同）
    assert {s["id"]: s["name"] for s in survey.merge(b, a)["shops"]} == {s["id"]: s["name"] for s in m["shops"]}


def test_merge_tie_prefers_incoming_and_handles_empty():
    """时间相同取后到的（b）；None / 空 dict 当成空数据"""
    m = survey.merge({"shops": [shop("s1", 100, name="a")]}, {"shops": [shop("s1", 100, name="b")]})
    assert m["shops"][0]["name"] == "b"  # 时间相同，后到的赢
    assert survey.merge(None, None)["shops"] == []  # 两边都没有
    assert survey.merge({}, survey.empty("x"))["scene"] == "x"  # 场景 id 取有的那边


# ---------------------------------------------------------------------------
# apply_survey
# ---------------------------------------------------------------------------
def test_apply_replaces_doors_and_sets_attraction():
    """b1 标了两家店（三扇门，其中两扇重合）→ b1 的门换成实测的两扇；b2 没标 → 保持原样"""
    s = {"scene": "imported/x", "shops": [
        shop("s1", 1, category="food", doors=[{"pos": [5, 10], "normal": [0, 1]}, {"pos": [15, 10], "normal": [0, 1]}]),
        shop("s2", 2, category="retail", doors=[{"pos": [5.2, 10], "normal": [0, 1]}]),  # 和 s1 第一扇门只差 0.2 米: 同一扇
        shop("s3", 3, category="vacant", deleted=True),  # 删掉的不算
        shop("s4", 4, building="gone"),  # 楼已不在场景里: 跳过
    ]}
    sc = scene()  # 原场景，后面检查它没被改
    out = survey.apply_survey(sc, s)  # 写回
    b1_doors = [d["pos"] for d in out["doors"] if d["building"] == "b1"]  # b1 现在的门
    assert b1_doors == [[5, 10], [15, 10]]  # 重合的那扇只留一扇
    assert [d["pos"] for d in out["doors"] if d["building"] == "b2"] == [[35, 10]]  # b2 的门保持原样
    b1 = out["buildings"][0]  # b1 楼
    assert b1["attraction"] == pytest.approx(1.6 + 1.2)  # 餐饮 + 零售
    assert [x["id"] for x in b1["shops"]] == ["s1", "s2"]  # 楼上记了两家店
    assert "shops" not in out["buildings"][1]  # 没标的楼不加 shops
    assert out["survey"]["shops"] == 2 and out["survey"]["buildings"] == 1  # 写回统计
    assert out["surveyOf"] == "imported/x"  # 记下标注数据属于哪个场景
    assert len(sc["doors"]) == 3 and "survey" not in sc  # 原场景没被改


def test_apply_keeps_auto_doors_when_no_door_marked():
    """只填了属性、一扇门都没标的楼: 保留自动生成的门，但吸引力照样按业态算（全空置 → 0）"""
    s = {"scene": "d", "shops": [shop("s1", 1, category="vacant", doors=[])]}  # 只填了属性、没标门的空置店
    out = survey.apply_survey(scene(), s)  # 写回
    assert len([d for d in out["doors"] if d["building"] == "b1"]) == 2  # 自动生成的两扇门还在
    assert out["buildings"][0]["attraction"] == 0.0  # 全空置: 没人专门去
    # 对已经回写过的场景再回写: surveyOf 保持指向最初的那份
    again = survey.apply_survey(dict(out, surveyOf="orig"), s)  # 场景已经带 surveyOf
    assert again["surveyOf"] == "orig"  # 不被覆盖


def test_category_weights_match_frontend():
    """Python 的 CAT_W 和前端 model.js 的 CATEGORIES 必须一致，否则写回仿真的吸引力和前端说的不一样"""
    js = (ROOT / "src" / "survey" / "model.js").read_text("utf-8")  # 前端源码
    pairs = dict((k, float(w)) for k, w in re.findall(r"\{ id: '(\w+)', t: '[^']+', w: ([\d.]+) \}", js))
    assert pairs == survey.CAT_W  # 逐项相同


# ---------------------------------------------------------------------------
# sat_server 的 /api/survey
# ---------------------------------------------------------------------------
@pytest.fixture
def server(tmp_path, monkeypatch):
    """把导入服务的输出目录、场景目录、标注目录都指到临时目录"""
    import sat_server as sv  # 在 fixture 里导入，monkeypatch 改的是模块全局
    scenes = tmp_path / "scenes"  # 临时的场景目录
    (scenes / "imported").mkdir(parents=True)  # 导入场景的子目录
    monkeypatch.setattr(sv, "SCENES", scenes)  # 内置场景从这里读
    monkeypatch.setattr(sv, "OUT", scenes / "imported")  # 写回的场景写到这里
    monkeypatch.setattr(sv, "SURVEY_DIR", tmp_path / "survey")
    return sv, scenes


def test_server_survey_roundtrip_and_validation(server):
    """读（没有给空白）→ 两台手机先后上传 → 合并；非法场景 id 拒绝"""
    sv, _ = server
    assert sv.load_survey("imported/x") == survey.empty("imported/x")
    sv.save_survey("imported/x", {"shops": [shop("s1", 1)]})
    m = sv.save_survey("imported/x", {"shops": [shop("s2", 2)]})  # 第二台手机没有 s1，也不会把它弄丢
    assert sorted(s["id"] for s in m["shops"]) == ["s1", "s2"] and m["scene"] == "imported/x"
    assert sv.survey_path("imported/x").name == "imported__x.json"
    assert sorted(s["id"] for s in sv.load_survey("imported/x")["shops"]) == ["s1", "s2"]
    for bad in ["../x", "imported/../../etc", "", "a/b", "x" * 61]:
        with pytest.raises(ValueError):
            sv.survey_path(bad)


def test_server_apply_writes_new_scene(server):
    """写回: 生成 imported/<名字>-surveyed，原场景不动；内置场景的底图地址补 ../；再回写覆盖同一个文件"""
    sv, scenes = server
    sc = scene()
    sc["imagery"] = {"url": "demo.jpg", "widthM": 10, "heightM": 10}
    (scenes / "demo.json").write_text(json.dumps(sc), "utf-8")
    sv.save_survey("demo", {"shops": [shop("s1", 1)]})
    sid = sv.apply_survey("demo")
    assert sid == "imported/demo-surveyed"
    out = json.loads((scenes / "imported" / "demo-surveyed.json").read_text("utf-8"))
    assert out["imagery"]["url"] == "../demo.jpg" and out["surveyOf"] == "demo"
    assert [d["pos"] for d in out["doors"] if d["building"] == "b1"] == [[5.0, 10.0]]
    assert "survey" not in json.loads((scenes / "demo.json").read_text("utf-8"))  # 原场景没动
    # 在回写后的场景上再写回: 用 surveyOf 那份标注，覆盖自己，不会生成 -surveyed-surveyed
    assert sv.apply_survey("imported/demo-surveyed") == "imported/demo-surveyed"
    assert not (scenes / "imported" / "demo-surveyed-surveyed.json").exists()
    with pytest.raises(ValueError):
        sv.apply_survey("nope")  # 场景不存在
