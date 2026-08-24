/**
 * dsh-service-watchdog — browser face.
 *
 * Contributions:
 * 1. A service status card at the sidebar foot (`sidebar.footer.action`) with a
 *    live running/stopped/starting dot and a restart button. When the service
 *    is up and has active work (running agents / queued messages / background
 *    jobs), the restart asks for a second confirmation first.
 * 2. A settings card (`settings.plugin.item`) for the watchdog port, login
 *    autostart, and crash auto-restart.
 *
 * The watchdog lives on a separate loopback port (default 3199) and stays
 * reachable after the DSH service dies, so the restart button keeps working.
 * The watchdog port is read from settings and cached in localStorage so it
 * survives a service stop.
 */
window.__ModuleLoader__.load({
  id: 'dsh-service-watchdog/client',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var react = require('react')
    var useSyncExternalStore = react.useSyncExternalStore

    var cssId = 'dsh-service-watchdog/client'
    var css = [
      '.dssc-card{display:flex;flex-direction:column;gap:6px;width:100%;box-sizing:border-box;padding:8px 10px;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:16px}',
      '.dssc-row{display:flex;align-items:center;gap:8px}',
      '.dssc-dot{width:8px;height:8px;border-radius:50%;flex:none}',
      '.dssc-dot.up{background:var(--dsw-alias-state-success-primary)}',
      '.dssc-dot.down{background:var(--dsw-alias-state-error-primary)}',
      '.dssc-dot.starting{background:#f59e0b;animation:dssc-pulse 1.2s ease-in-out infinite}',
      '.dssc-dot.unknown{background:var(--dsw-alias-border-l1)}',
      '@keyframes dssc-pulse{0%,100%{opacity:1}50%{opacity:.3}}',
      '.dssc-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}',
      '.dssc-sub{color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dssc-btn{flex:none;font:inherit;font-size:11px;line-height:16px;padding:2px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);cursor:pointer}',
      '.dssc-btn:disabled{opacity:.45;cursor:not-allowed}',
      '.dssc-modal{position:fixed;inset:0;z-index:2147483500;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.45)}',
      '.dssc-dialog{max-width:min(420px,calc(100vw - 32px));box-sizing:border-box;padding:16px;border-radius:12px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);box-shadow:0 10px 40px rgba(0,0,0,.3);font-size:13px;line-height:20px}',
      '.dssc-dialog h4{margin:0 0 8px;font-size:14px}',
      '.dssc-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:14px}',
      '.dssc-btn.danger{background:var(--dsw-alias-state-error-primary);border-color:transparent;color:#fff}',
      '.dssc-field{display:flex;flex-direction:column;gap:4px;padding:8px 0;border-top:1px solid var(--dsw-alias-border-l2)}',
      '.dssc-field>label{font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary)}',
      '.dssc-field input{box-sizing:border-box;width:100%;padding:6px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}',
      '.dssc-check{display:flex;align-items:center;gap:8px;padding:8px 0;border-top:1px solid var(--dsw-alias-border-l2);font-size:13px}',
      '.dssc-hint{font-size:11px;color:var(--dsw-alias-label-caption)}',
      '.dssc-ok{color:var(--dsw-alias-state-success-primary)}',
      '.dssc-err{color:var(--dsw-alias-state-error-primary)}',
      'div:has(> [data-slot="sidebar.footer.action"]){flex-direction:column !important;gap:6px}',
    ].join('')
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="' + cssId + '"]') === null) {
      var tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-service-watchdog'
      tag.dataset.pluginCss = cssId
      tag.textContent = css
      document.head.appendChild(tag)
    }

    var DEFAULT_PORT = 3199
    var wdPort = DEFAULT_PORT
    try {
      var cached = localStorage.getItem('dsh-sc-wdport')
      if (cached) {
        var n = Number(cached)
        if (Number.isFinite(n) && n > 0) wdPort = n
      }
    } catch {
      /* localStorage unavailable */
    }

    function wdUrl(path) {
      return 'http://127.0.0.1:' + wdPort + path
    }

    function useSettingsSnapshot(scope) {
      var snapshot = useSyncExternalStore(
        function (onChange) { return scope.subscribe(onChange) },
        function () { return scope.getSnapshot() },
      )
      var ready = snapshot.status === 'ready' && snapshot.value !== undefined
      return { value: ready ? snapshot.value : undefined, writable: snapshot.writable === true && ready, ready: ready }
    }

    var STATUS_LABEL = { up: '服务运行中', down: '服务已停止', starting: '服务启动中…', unknown: '状态未知' }

    function formatUptime(ms) {
      if (!ms || ms < 0) return ''
      var s = Math.floor(ms / 1000)
      var d = Math.floor(s / 86400)
      var h = Math.floor((s % 86400) / 3600)
      var m = Math.floor((s % 3600) / 60)
      if (d > 0) return d + ' 天 ' + h + ' 时'
      if (h > 0) return h + ' 时 ' + m + ' 分'
      if (m > 0) return m + ' 分'
      return s + ' 秒'
    }

    function RestartCard(props) {
      var state = useSettingsSnapshot(props.scope)
      var statusState = react.useState('unknown')
      var wdUpState = react.useState(false)
      var restartingState = react.useState(false)
      var confirmState = react.useState(null)
      var resultState = react.useState(null)
      var uptimeState = react.useState(null)
      var status = statusState[0]
      var wdUp = wdUpState[0]
      var restarting = restartingState[0]
      var confirm = confirmState[0]
      var result = resultState[0]
      var uptime = uptimeState[0]

      // Keep the watchdog port in sync with settings and localStorage.
      react.useEffect(function () {
        if (state.ready && state.value && Number.isFinite(Number(state.value.watchdogPort))) {
          wdPort = Number(state.value.watchdogPort)
          try { localStorage.setItem('dsh-sc-wdport', String(wdPort)) } catch { /* ignore */ }
        }
      }, [state.ready, state.value])

      react.useEffect(function () {
        var alive = true
        var timer
        function poll() {
          fetch(wdUrl('/status'))
            .then(function (r) { return r.ok ? r.json() : null })
            .then(function (d) {
              if (!alive) return
              if (d) {
                wdUpState[1](true)
                statusState[1](d.service === 'starting' ? 'starting' : d.service === 'up' ? 'up' : 'down')
                if (d.service === 'up') {
                  fetch('/service-control/work')
                    .then(function (r) { return r.ok ? r.json() : null })
                    .then(function (w) { if (alive) uptimeState[1](w && typeof w.uptimeMs === 'number' ? w.uptimeMs : null) })
                    .catch(function () {})
                } else {
                  uptimeState[1](null)
                }
                return
              }
              wdUpState[1](false)
              // Watchdog unreachable: fall back to the service itself.
              fetch('/service-control/work')
                .then(function (r) { if (alive && r.ok) statusState[1]('up') })
                .catch(function () { if (alive) statusState[1]('down') })
            })
            .catch(function () {
              if (!alive) return
              wdUpState[1](false)
              fetch('/service-control/work')
                .then(function (r) { if (alive && r.ok) statusState[1]('up') })
                .catch(function () { if (alive) statusState[1]('down') })
            })
        }
        poll()
        timer = setInterval(poll, 3000)
        return function () { alive = false; clearInterval(timer) }
      }, [])

      react.useEffect(function () {
        if (!result) return
        var t = setTimeout(function () { resultState[1](null) }, 6000)
        return function () { clearTimeout(t) }
      }, [result])

      function doRestart() {
        confirmState[1](null)
        restartingState[1](true)
        resultState[1](null)
        fetch(wdUrl('/restart'), { method: 'POST' })
          .then(function (r) { return r.ok ? r.json() : null })
          .then(function (d) {
            resultState[1](d && d.up
              ? { text: '重启成功，服务已运行', ok: true }
              : { text: d && d.error ? '重启失败：' + d.error : '重启未完成', ok: false })
          })
          .catch(function () { resultState[1]({ text: '重启失败：看门狗不可达', ok: false }) })
          .finally(function () { restartingState[1](false) })
      }

      function doStart() {
        restartingState[1](true)
        resultState[1](null)
        fetch(wdUrl('/start'), { method: 'POST' })
          .then(function (r) { return r.ok ? r.json() : null })
          .then(function (d) {
            resultState[1](d && d.ok ? { text: '服务已启动', ok: true } : { text: '启动失败', ok: false })
          })
          .catch(function () { resultState[1]({ text: '启动失败：看门狗不可达', ok: false }) })
          .finally(function () { restartingState[1](false) })
      }

      function onClick() {
        if (!wdUp || restarting) return
        if (status === 'down') {
          doStart()
          return
        }
        fetch('/service-control/work')
          .then(function (r) { return r.ok ? r.json() : null })
          .then(function (work) {
            if (work && work.busy) {
              confirmState[1](work)
            } else {
              doRestart()
            }
          })
          .catch(function () {
            // Host unreachable but watchdog says up — just restart.
            doRestart()
          })
      }

      var btnLabel = restarting ? '执行中…' : status === 'down' ? '启动' : '重启'
      var disabled = !wdUp || restarting

      var confirmModal = confirm
        ? react.createElement(
            'div',
            { className: 'dssc-modal', onClick: function () { confirmState[1](null) } },
            react.createElement(
              'div',
              { className: 'dssc-dialog', onClick: function (e) { e.stopPropagation() } },
              react.createElement('h4', null, '重启将中断进行中的工作'),
              react.createElement('p', null,
                '当前有 ' + confirm.runningAgents + ' 个进行中的会话、' +
                confirm.queuedMessages + ' 条排队消息、' + confirm.activeJobs + ' 个后台任务。'),
              react.createElement('p', { className: 'dssc-hint' }, '重启会杀掉这些会话与任务，且不可恢复。确定继续吗？'),
              react.createElement(
                'div',
                { className: 'dssc-actions' },
                react.createElement('button', { type: 'button', className: 'dssc-btn', onClick: function () { confirmState[1](null) } }, '取消'),
                react.createElement('button', { type: 'button', className: 'dssc-btn danger', onClick: doRestart }, '确认重启'),
              ),
            ),
          )
        : null

      var sub = wdUp ? null : '看门狗未运行，无法重启'
      return react.createElement(
        'div',
        { className: 'dssc-card', 'data-service-control': true, title: 'DSH 服务状态' },
        react.createElement(
          'div',
          { className: 'dssc-row' },
          react.createElement('span', { className: 'dssc-dot ' + (restarting ? 'starting' : status) }),
          props.wide !== false ? react.createElement('span', { className: 'dssc-label' }, STATUS_LABEL[status] || status) : null,
          // The restart/start button sits on the right of the status label (the
          // label has flex:1, pushing the button to the row's right edge — the
          // same X position as the cost-panel "充值" button).
          props.wide !== false
            ? react.createElement('button', {
                type: 'button',
                className: 'dssc-btn',
                onClick: onClick,
                disabled: disabled,
              }, btnLabel)
            : null,
        ),
        props.wide !== false && status === 'up' && typeof uptime === 'number'
          ? react.createElement(
              'div',
              { className: 'dssc-row' },
              react.createElement('span', { className: 'dssc-sub', style: { flex: 1 } }, '已运行 ' + formatUptime(uptime)),
            )
          : null,
        props.wide !== false && sub
          ? react.createElement(
              'div',
              { className: 'dssc-row' },
              react.createElement('span', { className: 'dssc-sub', style: { flex: 1 } }, sub),
            )
          : null,
        props.wide !== false && result
          ? react.createElement(
              'div',
              { className: 'dssc-row' },
              react.createElement('span', { className: 'dssc-sub' + (result.ok ? ' dssc-ok' : ' dssc-err'), style: { flex: 1 } }, result.text),
            )
          : null,
        confirmModal,
      )
    }

    function SettingsCard(props) {
      var state = useSettingsSnapshot(props.scope)
      if (!state.ready) {
        return react.createElement('div', { className: 'dssc-card', 'data-service-control-settings': true },
          react.createElement('p', { className: 'dssc-hint' }, '设置加载中…'))
      }
      var value = state.value || {}
      function toggle(field) {
        return function (event) {
          props.scope.set(field, event.target.checked).catch(function (e) { console.error('[dsh-service-watchdog] save failed:', e) })
        }
      }
      function num(field) {
        return function (event) {
          var n = Number(event.target.value)
          if (Number.isFinite(n) && n > 0) {
            props.scope.set(field, n).catch(function (e) { console.error('[dsh-service-watchdog] save failed:', e) })
          }
        }
      }
      return react.createElement(
        'div',
        { className: 'dssc-card', 'data-service-control-settings': true },
        react.createElement('div', { className: 'dssc-field' },
          react.createElement('label', null, '看门狗控制端口'),
          react.createElement('input', { type: 'number', defaultValue: value.watchdogPort || DEFAULT_PORT, onBlur: num('watchdogPort') }),
          react.createElement('span', { className: 'dssc-hint' }, '默认 3199；仅本机 127.0.0.1 监听。')),
        react.createElement('label', { className: 'dssc-check' },
          react.createElement('input', { type: 'checkbox', checked: value.autostart !== false, onChange: toggle('autostart') }),
          react.createElement('span', null, '开机自启（登录后自动拉起看门狗与服务）')),
        react.createElement('label', { className: 'dssc-check' },
          react.createElement('input', { type: 'checkbox', checked: value.crashRestart !== false, onChange: toggle('crashRestart') }),
          react.createElement('span', null, '崩溃自动重启（服务异常退出时自动拉起）')),
        react.createElement('p', { className: 'dssc-hint' },
          '看门狗是独立常驻进程（几 MB），服务关闭后仍存活，负责按需重启服务；日志在 %LOCALAPPDATA%\\DeepSeekHarnessApp\\watchdog.log。'),
      )
    }

    function apply(ctx) {
      var scope = ctx.settingsScope.bind({ namespace: 'service-control' })
      ctx.slots.inject('sidebar.footer.action', function () {
        return ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'service-control',
          order: 30,
        }, function Card(props) {
          return react.createElement(RestartCard, { scope: scope, wide: props.wide !== false })
        })
      })
      ctx.slots.inject('settings.plugin.item', function () {
        return ctx.slots.register({
          name: 'settings.plugin.item',
          key: 'service-control',
        }, function S() { return react.createElement(SettingsCard, { scope: scope }) })
      })
    }

    exports.name = 'service-control-ui'
    exports.apply = apply
    exports.inject = ['slots', 'settingsScope']
    return module.exports
  },
})
