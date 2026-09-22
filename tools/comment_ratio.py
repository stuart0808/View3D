#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
统计注释率: 注释行 / 非空行。JS 认 //、/* */、* 开头的行和行尾 //，.vue 模板再认 <!-- -->；Python 认 #、三引号文档字符串。
    python tools/comment_ratio.py src/city tools tests
"""
import re  # 识别引号里的 // 和 #
import sys
from pathlib import Path


def ratio(path):
    """返回 (代码行数, 注释行数)。空行不算；一行既有代码又有行尾注释时两边都记一次"""
    lines = path.read_text("utf-8", errors="replace").splitlines()  # 编码坏了也不中断
    code = comment = 0  # 计数器
    in_block = False  # 是否在块注释 / 文档字符串里
    py = path.suffix == ".py"  # .vue 和 .js 走同一套规则
    for raw in lines:
        s = raw.strip()  # 去掉缩进再判断开头
        if not s:
            continue  # 空行不计
        if py:
            # 三引号: 整段算注释
            if s.startswith(('"""', "'''")):
                comment += 1
                if s.count('"""') + s.count("'''") == 1:  # 单行 """...""" 有两个引号对，不切换状态
                    in_block = not in_block
                continue
            if in_block or s.startswith("#"):  # 文档字符串内部 / 整行注释
                comment += 1
            else:
                code += 1
                if "#" in s and not re.search(r"['\"].*#.*['\"]", s):  # 行尾 #；引号里的（如颜色 '#FF0000'）不算
                    comment += 1  # 行尾注释也算一行注释（同一行既是代码也是注释）
            continue
        if in_block:  # JS 块注释 / HTML 注释内部
            comment += 1
            if "*/" in s or "-->" in s:
                in_block = False
            continue
        if s.startswith("<!--"):  # .vue 模板里的 HTML 注释
            comment += 1
            if "-->" not in s:
                in_block = True  # 多行 HTML 注释，直到 --> 为止
            continue  # 这一行不再按 JS 规则判断
        if s.startswith("/*"):  # 块注释开头（含 /** JSDoc）
            comment += 1
            if "*/" not in s:
                in_block = True  # 没在同一行结束
        elif s.startswith("//") or s.startswith("*"):  # 行注释，或 JSDoc 里以 * 开头的行
            comment += 1
        else:
            code += 1
            if "//" in s and not re.search(r"['\"`].*//.*['\"`]", s):  # 行尾注释；引号里的 // (如 URL) 不算
                comment += 1
    return code, comment


def main():
    """按参数给的目录递归统计，按注释率升序打印，最后一行合计"""
    roots = sys.argv[1:] or ["src/city"]  # 默认只看引擎目录
    rows = []
    for r in roots:
        for p in sorted(Path(r).rglob("*")):  # 目录递归；直接给文件路径的话 rglob 不会匹配到自己
            if p.suffix in (".js", ".py", ".vue") and "node_modules" not in p.parts:
                code, com = ratio(p)
                rows.append((p.as_posix(), code, com))  # (路径, 代码行, 注释行)
    rows.sort(key=lambda t: t[2] / max(1, t[1]))  # 最差的排最前
    tc = tm = 0  # 合计
    for path, code, com in rows:
        tc += code
        tm += com
        print(f"{com / max(1, code):6.0%}  {com:4d}/{code:<4d}  {path}")  # 注释率  注释/代码  路径
    print(f"{tm / max(1, tc):6.0%}  {tm:4d}/{tc:<4d}  合计")


if __name__ == "__main__":  # 也可以 import ratio() 在别的脚本里用
    main()
