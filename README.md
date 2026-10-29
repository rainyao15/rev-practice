# NetEase Wallpaper Engine

> 逆向网易云音乐 PC 端的渲染层，接管它的背景合成权 —— 把 Wallpaper Engine 的
> 动态壁纸注入客户端，并把 WE 自己的属性面板变成参数面板。

**进程内调试协议挂载 · 合成层定位 · 非侵入式 DOM 覆写 · 跨应用属性总线**

![platform](https://img.shields.io/badge/platform-Windows%2010%2F11-0078D4)
![client](https://img.shields.io/badge/client-3.1.x-FF2C55)
![engine](https://img.shields.io/badge/CEF-91.0.4472.169-4B8BBE)
![patched%20files](https://img.shields.io/badge/patched%20files-0-success)
![license](https://img.shields.io/badge/license-MIT-lightgrey)

---

**English** — A bridge that injects Wallpaper Engine wallpapers into the NetEase
CloudMusic desktop client. It attaches to the app's own CEF debug port, locates the
`z-index:-100` background layer of the web UI, and drops a wallpaper layer beneath
it. Parameters live in Wallpaper Engine's native property panel — the client itself
gets no extra UI. No binary is patched or redistributed. Windows only.

---

## 它做了什么

网易云 PC 端是个 CEF 应用，界面整层打包在 `orpheus.ntpk`（未加密 ZIP，1411 个文件）里。本项目：

1. 通过客户端自身透传的 `--remote-debugging-port` 挂上 DevTools 协议；
2. 定位背景渲染链路 —— `AppBackground` 那个 `z-index:-100` 的合成层；
3. 以独立图层注入壁纸（`<video>` / MJPEG），原生遮罩继续压在它上面；
4. 读取 Wallpaper Engine 的 `config.json`，把面板里的滑块实时映射成 CSS。

**没有修改任何 `.exe` / `.dll` / 安装包。** 客户端更新后最多是选择器要重新对一遍。

```
Wallpaper Engine                          NetEase CloudMusic
┌──────────────────┐                      ┌──────────────────────────┐
│ 属性面板          │  config.json         │  CEF renderer            │
│ ne_opacity ──────┼────────────────────▶ │  ┌────────────────────┐  │
│ ne_dim  ne_tint  │   1s poll            │  │ #__neVideo  z:-100 │  │
│ ne_blur ne_fit   │                      │  ├────────────────────┤  │
└──────────────────┘                      │  │ 原生 .before 遮罩   │  │
        │ Scene                           │  ├────────────────────┤  │
        ▼                                 │  │ UI（卡片 / 歌词）   │  │
┌──────────────────┐  PrintWindow         │  └────────────────────┘  │
│ WPEOverlapped-   │ ─ JPEG ─▶ MJPEG ────▶│           ▲              │
│ Wallpaper 离屏   │   127.0.0.1:2001     │           │ CDP inject   │
└──────────────────┘                      └───────────┴──────────────┘
```

详细原理见 [docs/how-it-works.md](docs/how-it-works.md)。

## 能力

| | |
|---|---|
| 背景接管 | 主界面 / 歌单 / 黑胶歌词页全程透出壁纸，卡片与文字保持在上层 |
| 壁纸类型 | **Video**（原生 `<video>` 解码）、**Scene**（捕获 WE 渲染窗口 → MJPEG）、**Web** 不支持 |
| 参数面板 | 「网易云背景」分组自动出现在 WE 的壁纸属性面板里，8 个参数 |
| 毛玻璃 | 底栏、搜索弹层走 `backdrop-filter`，主题色自动跟随 |
| 生命周期 | 客户端重启自愈；页面刷新 / 路由切换后重新挂载；窗口隐藏时停止绘制 |

## 要求

- Windows 10 / 11
- 网易云音乐 PC 端 3.1.x（已验证 `3.1.42.205594`，CEF 91）
- Wallpaper Engine（Steam）
- Node.js 18+（只用标准库，无依赖）
- .NET Framework 4（Windows 自带，仅用于编译抓帧器）

## 使用

```bat
:: 1. 把 "网易云背景" 分组写进壁纸的 project.json（一次即可，可 --revert 撤销）
node src\we-panel.mjs --all

:: 2. 编译抓帧器（Scene 壁纸需要）
native\build.cmd

:: 3. 启动桥接
start.cmd
```

`start.cmd` 会在客户端没带调试端口时**自动重启它**（约 5–10 秒恢复）。
不想被强行重启就加 `--no-relaunch`，只想指定某张壁纸就 `node src\we-panel.mjs --dir <路径>`。

之后在 WE 里选中任意壁纸，属性面板底部就是那 8 个滑块。

## 参数

| 键 | 类型 | 作用 |
|---|---|---|
| `ne_enabled` | bool | 总开关，关掉即回原生外观 |
| `ne_opacity` | 0–100 | 壁纸不透明度 |
| `ne_dim` | 0–100 | 明暗调节（叠一层黑） |
| `ne_tint` | color | 染色 |
| `ne_tintstrength` | 0–100 | 染色强度 |
| `ne_blur` | 0–60 px | 背景模糊 |
| `ne_fit` | cover / contain / fill / tile | 铺满方式 |
| `ne_audio` | bool | 是否播放壁纸音轨 |

## 自定义路径

默认会自动探测（注册表 → 常见安装位置 → Steam 库）。探测不到就复制一份
`config.example.json` 为 `config.json`，填：

```json
{
  "clientExe": "C:\\Program Files\\NetEase\\CloudMusic\\cloudmusic.exe",
  "weRoot": "D:\\SteamLibrary\\steamapps\\common\\wallpaper_engine",
  "workshopRoot": "D:\\SteamLibrary\\steamapps\\workshop\\content\\431960"
}
```

也可以用环境变量 `NETEASE_EXE` / `WE_ROOT` / `WE_WORKSHOP`。

## 已知限制

- **桌面歌词、迷你播放器改不了** —— 那是原生分层窗口，不在 CEF 里，CSS 碰不到。
- **Scene 壁纸有帧率上限**：1080p 实测 ~57 fps，4K 会掉到 ~17 fps（瓶颈是抓帧 + JPEG 编码）。
- **Web 类壁纸不支持** —— 需要单独的浏览器上下文，尚未实现。
- 客户端大版本更新后，样式选择器可能需要重新对一遍（`StyledBackground_s1tq3cvd` 这类 class 带哈希）。
- **首次切到 Scene 壁纸时，WE 的 pop-out 窗口会闪约 10–20 ms**（一帧）。之后再换 Scene
  壁纸就是原地复用窗口，不会再出现。

## 几个踩过的坑

- **WE 会复用已经存在的 pop-out**：再发一次 `openWallpaper -playInWindow` 只是换内容，
  窗口句柄和位置都不变。所以换 Scene 壁纸**不要关旧窗口**——关了再开就会有一个大窗口
  弹出来停两三秒。
- **窗口必须保持可见**（只是挪到 `-4000,-4000`）：`SW_HIDE` 之后窗口不再参与合成，
  `PrintWindow` 拿到的是一整张黑图。
- **抓帧进程要比 `openWallpaper` 先启动**：它自己启动要 ~150 ms，而 WE 80 ms 就把窗口
  显示出来了；顺序反过来窗口会在屏幕中间多停两三百毫秒。
- `openWallpaper` 不接受 `-x` / `-y`，传了也会被忽略（窗口永远开在 `0,0`）。

## 免责

仅供个人学习与本地使用。不修改、不重分发客户端任何文件，不提供任何壁纸资源；
壁纸版权归原作者所有。使用本工具产生的任何后果由使用者自行承担。

## License

MIT
