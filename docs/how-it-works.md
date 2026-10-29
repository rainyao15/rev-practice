# 它是怎么工作的

这个项目没有注入 DLL、没有 hook 任何函数、没有改一个字节的客户端文件。
所有事情都发生在两个应用的**边界**上。

## 1. 进得去：CEF 的调试端口

网易云 PC 端是 CEF 应用。`cloudmusic.exe` 会把自己收到的命令行原样转给
`CefMainArgs`，所以：

```bat
cloudmusic.exe --remote-debugging-port=9222
```

之后 `http://127.0.0.1:9222/json/list` 就会返回页面目标：

```
"title": "网易云音乐",
"url":   "orpheus://orpheus/pub/app.html"
```

这是整个项目最关键的发现 —— 它让"改界面"从逆向工程降级成了写 CSS。
（早期怀疑它用 `--disable-developer-tools` 把调试口封了，实际没有；
那个开关只影响它自己弹出的 DevTools 窗口。）

## 2. 找得到：背景合成层

界面是一棵 DOM 树，背景是其中一个 `z-index:-100` 的 div：

```
body                       background: var(--colorBackground)
└ #__neBase                ← 我们补的不透明底（CEF 窗口底色是白的）
└ #__neVideo               ← 我们注入的壁纸层  position:fixed inset:0 z-index:-100
└ .StyledBackground_xxx    ← 原背景，background 被改成 none，保留子元素 .before
   └ .before               background: colorMask5   （原生明暗遮罩，自动压在壁纸上）
└ #root                    界面本体，永远在最上面
```

因为 `.before` 遮罩是 `StyledBackground` 的子元素，我们只要把父元素的
`background` 清空，那层遮罩就会自动落在壁纸上 —— 不需要自己实现"压暗"。

## 3. 喂得进：两种壁纸的取数方式

**Video**：`media-server.mjs` 起一个支持 Range 的本地 HTTP 服务，`<video src>` 直接拉。
客户端的 CSP 只有 `script-src` 和 `connect-src`，没有 `default-src`/`media-src`，
所以 `http://127.0.0.1` 完全合法。

**Scene**：WE 的 Scene 是私有格式（模型 + 材质 + 粒子），只能借 WE 自己渲染。
调用 `wallpaper64.exe -control openWallpaper -file x.pkg -playInWindow` 会开一个
普通窗口（类名 `WPEOverlappedWallpaper`），然后用：

```c
PrintWindow(hwnd, hdc, PW_RENDERFULLCONTENT);   // 2
```

把 DirectComposition 的画面抓成位图 —— 反直觉的是这对 D3D 窗口真的有效，
而且把窗口挪到屏幕外、甚至 `ShowWindow(hwnd, SW_HIDE)` 之后依然出帧。
抓到的位图裁掉标题栏、编码成 JPEG，通过 `multipart/x-mixed-replace` 推给
页面里的 `<img>`，由浏览器原生解码，每帧不经过 JS。

## 4. 调得动：面板寄生在 Wallpaper Engine

WE 的属性面板由壁纸 `project.json` 里的 `general.properties` 驱动，
支持 `bool / slider / color / combo / group / divider` 等类型。
所以往每张壁纸的 `project.json` 里写 8 个 `ne_*` 属性，
WE 就会把它们渲染成同面板里的滑块 —— 客户端一侧零 UI。

面板值不会直接送给我们，而是由 WE 写着 `config.json`：

```
Rain.wproperties["D:/…/xxx.mp4"].Monitor0.ne_opacity = 40
```

控制器每秒读一次，有变化就通过 CDP 改页面里的 CSS 变量。一条 1 秒的单向同步，
足以让"拖滑块 → 背景变化"感觉是实时的。

## 为什么不用 DLL 注入

能，但没必要，而且代价高：要处理 UAC、签名、客户端自愈、崩溃隔离。
现在的方案全部活在用户态的两个进程边界上，任何一边退出都不会带走另一边。
