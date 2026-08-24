# dsh-service-watchdog

DeepSeek Harness 主界面服务控制插件：**重启 / 状态 / 看门狗 / 开机自启**。

## 功能

- **状态显示**：侧边栏实时显示服务运行中 / 已停止 / 启动中，以及**服务已运行时长**（3s 轮询）。
- **快速重启**：一键重启 DSH web。重启前检测进行中的会话 / 排队消息 / 后台任务，若有则弹**二次确认**（显示数量）再杀，无则直接重启；重启后显示**成功/失败结果反馈**。
- **看门狗自愈**：DSH 启动时派生一个独立常驻进程（几 MB），服务崩溃后自动拉起（可关）；服务关闭后按钮仍能再次启动。
- **看门狗代码自更新**：host 每 15s 探测看门狗，若磁盘上的看门狗代码已变化则自动重启它加载新代码——改看门狗无需手动杀进程或重启电脑。
- **开机自启**：写 HKCU Run 键，登录后自动拉起看门狗与服务（可关）。
- **无残余进程**：重启用 `taskkill /T /F` 杀整棵进程树，确认端口释放后再拉起。

## 工作原理

- 看门狗监听 `127.0.0.1:<watchdogPort>`（默认 3199），浏览器直连它下发 `start` / `restart`，服务死了按钮依然可用。
- 看门狗暴露 loopback-only HTTP 接口：`/health`（含 codeHash/uptime）、`/status`、`/reload`、`/restart`、`/start`、`/stop`、`/shutdown`。
- 启动命令在插件安装时从当前进程自举（node 路径 / argv / cwd / 完整环境变量）并持久化到 `%LOCALAPPDATA%\DeepSeekHarnessApp\watchdog.json`，重启电脑后无需运行中的进程即可拉起。
- 日志：`%LOCALAPPDATA%\DeepSeekHarnessApp\watchdog.log`。

## 安装

```sh
dsh plugin --profile web add <本目录路径>
```

## 配置项（Settings → Plugins → Service control）

| 键 | 默认 | 说明 |
|---|---|---|
| watchdogPort | 3199 | 看门狗控制端口（仅本机监听）；运行时改端口会自动清掉旧看门狗 |
| autostart | true | 开机自启 |
| crashRestart | true | 崩溃自动重启（改动即时生效） |

## 安全

- 看门狗只绑 `127.0.0.1`；仅接受 loopback Host，且跨站 Origin 一律 403（防 CSRF / DNS-rebinding）。
- 杀进程前校验目标 PID 的映像是 node.exe，避免误杀占用同端口的其他程序。
- `watchdog.json` 持久化启动命令时过滤 token/key/secret/credential/CODEX_ 等密钥环境变量。

## 验证

```sh
node --test test/*.mjs
```
