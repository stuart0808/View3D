#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
统计注释率: 注释行 / 非空行。JS 认 //、/* */、* 开头的行和行尾 //；Python 认 #、三引号文档字符串。
    python tools/comment_ratio.py src/city tools tests
"""
import re
import sys
from pathlib import Path


def ratio(path):
    lines = path.read_text("utf-8", errors="replace").splitlines()
    code = comment = 0
    in_block = False
    py = path.suffix == ".py"
    for raw in lines:
        s = raw.strip()
        if not s:
            continue
        if py:
            # 三引号: 整段算注释
            if s.startswith(('"""', "'''")):
                comment += 1
                if s.count('"""') + s.count("'''") == 1:
                    in_block = not in_block
                continue
            if in_block or s.startswith("#"):
                comment += 1
            else:
                code += 1
                if "#" in s and not re.search(r"['\"].*#.*['\"]", s):
                    comment += 1  # 行尾注释也算一行注释（同一行既是代码也是注释）
            continue
        if in_block:
            comment += 1
            if "*/" in s:
                in_block = False
            continue
        if s.startswith("/*"):
            comment += 1
            if "*/" not in s:
                in_block = True
        elif s.startswith("//") or s.startswith("*"):
            comment += 1
        else:
            code += 1
            if "//" in s and not re.search(r"['\"`].*//.*['\"`]", s):
                comment += 1
    return code, comment


def main():
    roots = sys.argv[1:] or ["src/city"]
    rows = []
    for r in roots:
        for p in sorted(Path(r).rglob("*")):
            if p.suffix in (".js", ".py", ".vue") and "node_modules" not in p.parts:
                code, com = ratio(p)
                rows.append((p.as_posix(), code, com))
    rows.sort(key=lambda t: t[2] / max(1, t[1]))
    tc = tm = 0
    for path, code, com in rows:
        tc += code
        tm += com
        print(f"{com / max(1, code):6.0%}  {com:4d}/{code:<4d}  {path}")
    print(f"{tm / max(1, tc):6.0%}  {tm:4d}/{tc:<4d}  合计")


if __name__ == "__main__":
    main()
