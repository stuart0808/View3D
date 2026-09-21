# 街区人流仿真（Vue 3 + Three.js）

二维地图 + 简单色块标记 → 自动生成等轴测三维街区 + 人流 + 屋顶热力。

```
标记图.png ──[tools/map2scene.py]──> public/scenes/xxx.json ──[<CityScene>]──> 三维场景
```

## 跑起来

```bash
npm install
npm run dev            # http://localhost:5173/        示例场景
                       # http://localhost:5173/?scene=my  加载 public/scenes/my.json
```

## 从自己的地图生成场景

**1. 涂标记。** 用任意画图软件（PS / Figma / 画图）在地图上按下表涂色。建议在单独图层上涂、
只导出标记层（透明或灰底 PNG）；直接涂在彩色地图上也行，但底图里别有相近的高饱和颜色
（有的话先把底图去色，或调小 `--tol`）。

| 颜色 | 含义 | 画法 |
|---|---|---|
| 红 `#FF0000` | 商铺建筑（2 层） | 填充色块 |
| 橙 `#FF8000` | 商铺建筑（1 层） | 填充色块 |
| 品红 `#FF00FF` | 非商铺/高楼（5 层，无店面） | 填充色块 |
| 蓝 `#0000FF` | 车行道 | 填充色块 |
| 黄 `#FFFF00` | 店门（可选） | 小圆点，点在建筑边线上 |
| 青 `#00FFFF` | 人流出入口（可选） | 小圆点，点在人行区域 |

不用标的东西：**人行区域**（地块内非建筑非车道的部分自动算）、**斑马线**（路口自动生成，
长路段中途自动补）、**车道线**、**店门**（某栋商铺一个门都没标时，沿临街边自动布门）、
**出入口**（一个都没标时在地块四周自动放 8 个）。颜色/层数映射可以改，见 `tools/markers.default.json`，
用 `--markers` 指定。

**2. 转换。**

```bash
pip install -r tools/requirements.txt
python tools/map2scene.py 我的标记图.png -o public/scenes/my.json --width-m 320 --debug preview.png
```

`--width-m` 是整张图片宽度对应的实际米数（或用 `--mpp` 直接给 米/像素）。**一定要看一眼
`--debug` 输出的预览图**：红/紫框是识别出的建筑，绿色是人行铺装，蓝线是道路中心线，橙框是斑马线，
黄色短线是店门及朝向，青圈是出入口。

脚本做的事：按颜色分割 → 提轮廓 → 建筑**直角化**（找主方向，把歪的边吸附到正交轴，抹平小台阶；
斜边保留）→ 道路骨架化得到中心线和路口 → 自动斑马线/店门/出入口 → 坐标换算成米。
其他常用参数：`--no-ortho`（关直角化，异形建筑多时用）、`--site full`（整张图都算地块）、
`--door-spacing-m`、`--crosswalk-spacing-m`，完整列表 `-h`。

想验证流程可以先跑示例：`python tools/make_demo_map.py tools/samples/demo_marked.png`。

**3. 微调（可选）。** `scene.json` 是纯二维几何，可以直接手改：建筑的 `floors`、`kind`、
`attraction`（吸引力），`doors`、`portals` 的位置等。

## 在自己的 Vue 项目里用

拷走 `src/city/` 和 `src/components/CityScene.vue`，依赖只有 `three`。

```vue
<CityScene
  src="/scenes/my.json"
  :population="900"                      <!-- 同时在场人数 -->
  :dwell-scale="1.3"                     <!-- 店内停留时长倍率 -->
  :attraction="{ b1: 3, b4: 0.5 }"       <!-- 各建筑吸引力，接后端测算结果 -->
  :heat="true"
  @stats="onStats"                       <!-- 每秒: { walking, inside, perBuilding } -->
/>
```

组件本身不带任何 UI；`App.vue` 左下角那一条只是调试开关，可删。
后端只需要给聚合量（总人数、各建筑的客流/消费权重），小人的具体路径由前端生成，属于可视化示意。

## 代码结构

| 文件 | 作用 |
|---|---|
| `src/city/CityEngine.js` | 渲染器、正交相机（自动对准街区主方向）、灯光阴影、主循环 |
| `src/city/buildings.js` | 轮廓 → 圆角墙体、挑檐女儿墙、临街店面（玻璃/招牌/壁柱）、屋顶设备 |
| `src/city/ground.js` | 底座、路面、人行铺装、车道线/斑马线、雾化背景楼块 |
| `src/city/navgrid.js` | 可行走区域栅格化 + 每个目的地一张 Dijkstra 距离场 |
| `src/city/crowd.js` | 人群状态机 + 分离避让，InstancedMesh 一次绘制 |
| `src/city/heat.js` | 店内人数 → 密度纹理 → 屋顶色带 |

性能参考：示例场景 1000+ 人、14 个 draw call、60fps；仿真每帧约 1ms。

## 已知限制

- 建筑只按「轮廓拉伸 + 层数」生成，不还原真实立面。
- 导航网格 1m 一格（超大场景自动放粗），人行道窄于约 2m 的地方可能走不通。
- 道路只有中心虚线，没有车辆。
- 后续可以加 OSM / GeoJSON 导入器，只要输出同样结构的 scene.json，前端不用动。
