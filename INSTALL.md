# 安装说明

> 这份文档写给「第一次拿到这个包的人」。全程大约 3 分钟，不需要管理员权限，
> 不会修改网易云的任何文件，也不会动 Wallpaper Engine 的安装目录。

---

## 一、先确认你符合条件

| 需要 | 说明 | 怎么查 |
|---|---|---|
| Windows 10 / 11 | 只支持 Windows | — |
| 网易云音乐 PC 端 3.1.x | 在 `3.1.42.205594` 上验证过 | 客户端 → 设置 → 关于 |
| Wallpaper Engine | Steam 版，已安装并至少有一张壁纸 | Steam 库 |
| Node.js 18 或更新 | 只用标准库，不需要 `npm install` | 命令行执行 `node -v` |
| .NET Framework 4 | Windows 自带，仅用于编译两个小工具 | 一般不用管，装不上会有提示 |

Node.js 没装的话：去 <https://nodejs.org> 下载 LTS 版，一路下一步即可。装完**重新打开**
命令行窗口，`node -v` 能输出版本号就算成功。

---

## 二、安装

### 方式 A：双击（推荐）

解压压缩包，进入 `netease-wallpaper` 文件夹，**双击 `install.cmd`**。

它会做两件事：

1. 用 Windows 自带的 C# 编译器，把 `native/` 下的两个抓帧小工具编译成 exe
2. 给创意工坊里**每一张**壁纸的 `project.json` 追加一个「网易云背景」属性分组

看到这样的输出就算成功：

```
[1/2] building native helpers ...
Built ...\native\SceneCapture.exe
Built ...\native\SceneAudio.exe

[2/2] adding the property section to every wallpaper ...
synced: 396 changed, 0 already ok, 4 skipped, 396 wallpapers scanned

Done. Start the bridge with start.cmd, then pick any wallpaper in Wallpaper Engine.
```

### 方式 B：手动（想看清楚每一步）

```bat
cd /d 解压后的目录

:: 1. 编译抓帧工具（Scene 壁纸需要，Video 壁纸可以跳过）
native\build.cmd

:: 2. 给所有壁纸写属性分组
node src\we-panel.mjs --all

:: 3. 启动
start.cmd
```

### 方式 C：npm

```bat
npm run setup     :: 等于上面 1 + 2
npm start         :: 等于 start.cmd
```

---

## 三、安装到底改了什么

安装过程只写两类地方，都可以用 `uninstall.cmd` 还原：

| 位置 | 改了什么 |
|---|---|
| `steamapps\workshop\content\431960\<壁纸ID>\project.json` | 追加 9 个 `ne_*` 字段 + 一个分组声明 |
| `native\SceneCapture.exe`、`native\SceneAudio.exe` | 编译出来的两个小工具 |

**没有**改 `cloudmusic.exe`、`cloudmusic.dll`、`orpheus.ntpk`，也**没有**改 Wallpaper Engine
的安装目录。每张壁纸原文件都会在第一次修改前备份为 `project.json.bak-<时间戳>`。

---

## 四、第一次启动

1. **双击 `start.cmd`**。会弹出一个最小化的命令行窗口，那是控制器，**别关它**。
2. 如果你现在正开着网易云，控制器会发现它没带调试端口，**自动关掉再重开一次**
   （约 5–10 秒）。不想被打断就改用 `start.cmd --no-relaunch`，然后自己用
   `start.cmd` 启动客户端。
3. 打开 Wallpaper Engine，选一张壁纸，点右侧的**属性**。
4. 拉到面板**最下面**，会看到「网易云背景」分组（默认折叠，点一下展开）。
5. 拖参数 → 点面板底部的**「确认」** → 网易云背景约 0.1 秒后变化。

> **必须点「确认」才生效。** Wallpaper Engine 拖动滑块时不写配置文件，只有点确认才落盘，
> 所以我们只能读到确认之后的值。这是它的行为，不是本工具的 bug。

### 成功的标志

- 网易云窗口背景变成了壁纸，卡片、封面、文字仍在上面
- 切到歌单页、黑胶歌词页，壁纸依然在
- WE 的面板里能看到「网易云背景」九项

---

## 五、参数怎么用

| 控件 | 效果 |
|---|---|
| 启用网易云背景 | 总开关。关掉＝完全回到原生外观 |
| 壁纸不透明度 (%) | 0 = 看不见壁纸，100 = 全亮 |
| 明暗调节（叠黑 %） | 往壁纸上叠一层黑，深色壁纸配白字时调它 |
| 染色 / 染色强度 (%) | 给壁纸整体染一个颜色 |
| 背景模糊 (px) | 整张壁纸模糊，0 = 不模糊 |
| 铺满方式 | `cover` 裁切铺满 / `contain` 完整显示 / `fill` 拉伸 / `tile` 平铺 |
| 播放壁纸音轨 | 仅 Video 类壁纸，尚未充分验证 |
| Scene 壁纸音量 (%) | 仅 Scene 类壁纸，控制它自带的声音 |

> 这些值存在 Wallpaper Engine 的 `config.json` 里，按「壁纸文件路径 + 显示器」区分。
> 换一张壁纸，就是另一套参数。

---

## 六、验证是否装对了

命令行里依次执行（在解压目录下）：

```bat
:: 1. 属性分组写进去了吗
node src\we-panel.mjs --dir "D:\SteamLibrary\steamapps\workshop\content\431960\824586497"
::    返回 {"dir":"...","changed":[]} 就是已是最新；changed 里有内容表示刚补上

:: 2. 控制器在跑吗（应该能看到 2000 / 2001 两个本地端口）
netstat -ano | findstr ":2000 :2001"

:: 3. 调试端口通吗
curl http://127.0.0.1:9222/json/version
::    应该返回一段包含 "Chrome/91.0.4472.169" 的 JSON
```

三条都过，功能就是通的。

---

## 七、卸载

双击 `uninstall.cmd`，它会：

1. 停掉控制器和抓帧进程
2. 从每张壁纸的 `project.json` 里删掉所有 `ne_*` 字段
3. 删掉编译出的两个 exe

你的壁纸、Wallpaper Engine 设置、网易云设置**都不会受影响**。

卸载后 Wallpaper Engine 的**面板里可能还留着那个分组**，重启一次 WE 就没了（它把
`project.json` 缓存在内存里）。

---

## 八、常见问题

**Q：面板里找不到「网易云背景」分组**

1. 面板是**按壁纸**长出来的，得展开该壁纸的属性面板并拉到最下面
2. 这张壁纸是不是在你安装**之前**就已经被 WE 扫描过？WE 只在启动/刷新时读一次
   `project.json`，**重启一次 Wallpaper Engine** 即可
3. 确认这张壁纸在创意工坊目录下（`431960\<数字ID>\`），而不是 WE 内置壁纸
4. 手动补一次：`node src\we-panel.mjs --dir "<壁纸目录>"`

**Q：壁纸没出现，网易云还是原来的样子**

1. 控制器的那个命令行窗口还开着吗？关了就没有效果
2. `curl http://127.0.0.1:9222/json/version` 通不通？不通说明客户端没带调试端口，
   重新 `start.cmd`
3. WE 面板里的「启用网易云背景」是不是被关掉了
4. 「壁纸不透明度」是不是 0

**Q：Video 壁纸正常，Scene 壁纸是黑的**

1. 抓帧工具没编译：跑一次 `native\build.cmd`
2. 系统里没有 .NET Framework 4（`%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe`
   不存在）—— 从 Windows 功能里启用 .NET Framework 4.8
3. 有些 Scene 壁纸依赖显卡特性，笔记本双显卡切换时可能抓不到，试试让 WE 走独显

**Q：Scene 壁纸只有十几帧 / 很卡**

4K 屏幕下 Scene 是「WE 离屏渲染 → 抓帧 → JPEG 编码 → 浏览器解码」这条链路，1080p 能到
约 57 fps，4K 会掉到十几帧。想流畅就把 WE 的渲染分辨率调低，或换 Video 壁纸。

**Q：网易云更新后失效了**

界面样式里那些 class 名带哈希（比如 `StyledBackground_s1tq3cvd`），大版本更新可能变。
把新版客户端告诉我，或者自己 F12 找一下新的背景层 class，改 `src/inject.js` 里的选择器。

**Q：桌面歌词、迷你播放器没有壁纸**

那是原生分层窗口，不是网页，CSS 管不到。属于已知边界，不做。

**Q：杀毒软件报警**

本项目会在本机起两个本地 HTTP 服务（`127.0.0.1:2000` 供视频、`127.0.0.1:2001` 供 Scene
抓帧流），并用 `PrintWindow` 截取 Wallpaper Engine 自己的预览窗口，还会启动一个带
`--remote-debugging-port` 的网易云进程。这些行为在杀软看来确实敏感，全部源码可自行审阅，
不联网、不上传任何数据。

**Q：端口 2000 / 2001 被占用**

说明上一次的控制器没退干净：

```bat
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*main.mjs*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
```

**Q：我有多个 Steam 库 / 装在别的盘**

正常情况下会自动探测（注册表 → Steam 的 `libraryfolders.vdf` → 常见路径）。探测不到就
把 `config.example.json` 复制成 `config.json`，填上三个路径。

---

## 九、安全与边界

- 不联网：两个本地端口只监听 `127.0.0.1`，不接受外部连接，也不上传任何数据
- 不改客户端二进制：全部通过客户端自己透传的调试端口做页面层注入
- 不提供壁纸：壁纸来自你自己的 Wallpaper Engine 订阅，版权归原作者
- 仅供个人学习与本地使用，风险自负
