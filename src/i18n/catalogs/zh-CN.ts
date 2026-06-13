// zh-CN Translation_Catalog — every value sourced byte-for-byte from
// the existing hardcoded zh-CN copy in `src/main/tray.ts`,
// `src/main/services/dashboard.service.ts#HEALTH_STATUS_LABELS`, and
// the renderer surfaces enumerated in Requirement 4.2 of the
// i18n-multilingual-support spec.
//
// The catalog is the single source of truth for the zh-CN locale at
// runtime: `src/i18n/resolve.ts` reads it, and (after the rollout in
// task 14) every renderer surface plus the tray menu and the
// Provider_Auth import dialog will pull their copy from here via
// `t(key)` / `useT()`.
//
// `dashboard.health.*` values MUST match `HEALTH_STATUS_LABELS` in
// `src/main/services/dashboard.service.ts` byte-for-byte
// (Requirement 6.5). The map in dashboard.service.ts is preserved
// verbatim as a legacy logging label set (Requirement 6.7); this
// catalog carries the renderer-facing copy.
//
// Keys with placeholder tokens use the `{name}` form expected by
// `src/i18n/format.ts#applyParams` (regex
// `/\{([A-Za-z_][A-Za-z0-9_]*)\}/g`). Token names match the params
// callers pass at the use site; missing tokens leave the placeholder
// verbatim in the rendered string.

import type { TranslationCatalog } from './types';

export const zhCN: TranslationCatalog = {
  // ── Tray context menu ───────────────────────────────────────────
  // Source: `src/main/tray.ts#buildContextMenu`.
  'tray.menu.toggle': '显示/隐藏',
  'tray.menu.expand': '展开',
  'tray.menu.settings': '设置',
  'tray.menu.pause': '暂停采集',
  'tray.menu.resume': '继续',
  'tray.menu.quit': '退出',

  // ── Dashboard health labels ─────────────────────────────────────
  // Byte-for-byte identical to `HEALTH_STATUS_LABELS` in
  // `src/main/services/dashboard.service.ts` (Requirement 6.5).
  'dashboard.health.healthy': '外网正常',
  'dashboard.health.node_slow': '节点变慢',
  'dashboard.health.node_down': '节点中断',
  'dashboard.health.openclash_unreachable': '内核异常',
  'dashboard.health.home_down': '家庭离线',
  'dashboard.health.partial_outage': '部分中断',

  // ── Native dialog filter labels ────────────────────────────────
  // Source: `src/main/app.ts` Provider_Auth import dialog filter
  // array. The current values are the literal English strings
  // `'CPA Auth'` and `'All'`; preserving them here means the zh-CN
  // surface is unchanged after the rollout.
  'dialog.openAuthFile.filter.cpaAuth': 'CPA Auth',
  'dialog.openAuthFile.filter.all': 'All',

  // ── Expanded window — tab labels and chrome ────────────────────
  // Source: `src/renderer/App.tsx` ExpandedRoot TABS / topbar / aria.
  'expanded.tab.network': '网络',
  'expanded.tab.usage': '用量',
  'expanded.tab.settings': '设置',
  'expanded.aria.mainNav': '主导航',
  'expanded.aria.refreshNow': '立即刷新',
  'expanded.refresh.title': '立即刷新',

  // ── Expanded window — Network tab card / panel chrome ──────────
  'dashboard.network.cardAria': '网络状态',
  'dashboard.network.eyebrow': 'network · 连通性',
  'dashboard.network.latencyRangeAria': '延迟区间',
  'dashboard.network.liveAria': '实时数据',
  'dashboard.network.liveTitle': '实时数据',
  'dashboard.network.avgLatencyAria': '平均延迟',
  'dashboard.network.waitingNodeData': '等待节点数据',
  'dashboard.network.waitingData': '等待数据中…',
  'dashboard.network.nodeListAria': '节点列表',
  'dashboard.network.nodeTitle': '节点',
  'dashboard.network.groupMeta': '分组',
  'dashboard.network.groupSelectorAria': '选择节点分组',

  // ── Renderer boot states ───────────────────────────────────────
  // Source: `src/renderer/App.tsx` boot fallback + SettingsView
  // load placeholder. The literal `"preload bridge unavailable"`
  // stays locale-neutral (Requirement 10.3) and is intentionally
  // NOT a Translation_Key.
  'boot.loading': '加载中…',
  'boot.loadingSettings': '加载设置中…',
  'boot.cannotLoadSettings': '无法加载设置',
  'boot.waitingData': '等待数据中…',
  'boot.waitingNodes': '等待节点数据',

  // ── SettingsView — section rail labels and hints ──────────────
  // Source: `SECTIONS` in `src/renderer/components/SettingsView.tsx`.
  'settings.section.appearance.label': '外观',
  'settings.section.appearance.hint': '深浅色与悬浮窗风格',
  'settings.section.controller.label': '控制器',
  'settings.section.controller.hint': 'OpenClash 主控连接',
  'settings.section.probes.label': '探测目标',
  'settings.section.probes.hint': '外网连通性 URL',
  'settings.section.groups.label': '主分组',
  'settings.section.groups.hint': '展示与切换',
  'settings.section.router.label': '路由器',
  'settings.section.router.hint': '内网健康检测',
  'settings.section.intervals.label': '刷新节奏',
  'settings.section.intervals.hint': '采样频率 (ms)',
  'settings.section.switching.label': '切换',
  'settings.section.switching.hint': '节点切换行为',
  'settings.section.management.label': '管理接口',
  'settings.section.management.hint': 'OpenClash LuCI',
  'settings.section.accounts.label': 'AI 账号',
  'settings.section.accounts.hint': '导入认证文件或填写 API key',

  // ── SettingsView — chrome (root, navigation, save bar) ─────────
  'settings.aria.root': '设置',
  'settings.aria.nav': '设置导航',
  'settings.action.save': '保存',
  'settings.action.discard': '放弃修改',
  'settings.action.saved': '已保存',
  'settings.action.unknownError': '未知错误',
  'settings.save.unknownError': '清除凭据时发生未知错误',

  // ── Appearance section — color mode / font scale / compact zoom
  'settings.appearance.colorMode.label': '色彩模式',
  'settings.appearance.colorMode.hint': '仅影响展开窗；悬浮窗使用下方主题。',
  'settings.appearance.colorMode.dark': '深色',
  'settings.appearance.colorMode.light': '浅色',
  'settings.appearance.colorMode.aria': '色彩模式',
  'settings.appearance.fontScale.label': '界面字号',
  'settings.appearance.fontScale.hint':
    '统一调整展开窗的标题、正文、按钮、表格和输入框字号。',
  'settings.appearance.fontScale.aria': '界面字号比例',
  'settings.appearance.compactZoom.label': '悬浮窗缩放',
  'settings.appearance.compactZoom.hint':
    '放大悬浮窗物理像素，让 360px 宽的悬浮窗在高分屏上更清晰；同时按比例放大窗口。',
  'settings.appearance.compactZoom.aria': '悬浮窗缩放比例',
  // Template: `悬浮窗主题：${opt.label}` → `悬浮窗主题：{name}`.
  'settings.appearance.theme.cardAria': '悬浮窗主题：{name}',

  // ── Appearance section — compact theme presets ─────────────────
  // Source: COMPACT_THEME_OPTIONS in SettingsView.tsx (eleven
  // presets — the six v2 design-language presets followed by the
  // five v1 legacy presets).
  'settings.appearance.theme.liquidGlass.label': '液态玻璃',
  'settings.appearance.theme.liquidGlass.description':
    '浅色半透明玻璃，桌面 widget 般通透。',
  'settings.appearance.theme.materialYou.label': 'Material You',
  'settings.appearance.theme.materialYou.description':
    '浅色 MD3 双色块，亲和现代。',
  'settings.appearance.theme.softNeumorph.label': '柔和拟态',
  'settings.appearance.theme.softNeumorph.description':
    '浅色凸起外壳与内凹槽，安静低噪。',
  'settings.appearance.theme.paperDashboard.label': '纸感仪表',
  'settings.appearance.theme.paperDashboard.description':
    '近白纸面 + 细线分隔，办公低干扰。',
  'settings.appearance.theme.mintMonitor.label': '薄荷监控',
  'settings.appearance.theme.mintMonitor.description': '暗色半透明卡片，参考图风格。',
  'settings.appearance.theme.deviceOled.label': '硬件 OLED',
  'settings.appearance.theme.deviceOled.description':
    '金属外壳 + 黑色 OLED 屏 + LED 段条。',
  'settings.appearance.theme.obsidianGlass.label': '黑曜玻璃',
  'settings.appearance.theme.obsidianGlass.description':
    '深色磨砂质感，桌面常驻不抢眼。',
  'settings.appearance.theme.auroraRing.label': '极光环',
  'settings.appearance.theme.auroraRing.description': '边缘极光缓慢流动，状态色感强。',
  'settings.appearance.theme.holoGrid.label': '全息网格',
  'settings.appearance.theme.holoGrid.description': 'HUD 风格网格 + 慢扫描线。',
  'settings.appearance.theme.liquidMetal.label': '液态金属',
  'settings.appearance.theme.liquidMetal.description': '石墨与冷光泽，适合深色桌面。',
  'settings.appearance.theme.signalPulse.label': '信号脉冲',
  'settings.appearance.theme.signalPulse.description': '随状态色脉动的同心圆。',

  // ── Locale picker (Requirement 8) ──────────────────────────────
  // The picker control itself is added in task 11.1; the catalog
  // entries here populate the surrounding `<Field label hint>` and
  // the eager-commit failure surface. The two visible option
  // labels (`中文（简体）` / `English`) stay inline-literal in
  // SettingsView per Requirement 8.2 and are NOT keys.
  'settings.locale.label': '语言',
  'settings.locale.hint': '切换后立即生效，无需重启应用。',
  'settings.locale.errorPersistFailed': '语言保存失败，请稍后重试',

  // ── Controller section ─────────────────────────────────────────
  'settings.controller.url.label': 'Controller URL',
  'settings.controller.url.hint': 'OpenClash 主控制器地址，需以 http(s):// 开头',
  'settings.controller.url.placeholder': 'http://192.168.1.1:9090',
  'settings.controller.secret.label': 'Secret',
  'settings.controller.secret.hint': '仅写入；保存后清空，不显示当前值',
  'settings.controller.secret.placeholder': '留空则保留现有 secret',
  'settings.controller.secret.showAria': '显示 secret',
  'settings.controller.secret.hideAria': '隐藏 secret',

  // ── URL validation messages ────────────────────────────────────
  // Source: `validateManagementUrl` in SettingsView.tsx. The four
  // messages are funnelled through `t()` so the renderer surfaces a
  // single canonical phrasing across both Controller URL and LuCI
  // URL fields.
  'settings.validation.urlInvalid': '必须是 http:// 或 https:// 开头的合法 URL',
  'settings.validation.urlScheme': '必须使用 http:// 或 https://',
  'settings.validation.urlNoCreds': 'URL 不应包含用户名或密码',
  'settings.validation.urlNoQuery': 'URL 不应包含 query 或 fragment',

  // ── Probes section ─────────────────────────────────────────────
  'settings.probes.placeholder': 'https://example.com',
  'settings.probes.addLabel': '添加探测 URL',
  'settings.probes.itemAria': 'Probe URL',

  // ── Primary groups section ─────────────────────────────────────
  'settings.groups.placeholder': 'group name',
  'settings.groups.addLabel': '添加分组',
  'settings.groups.itemAria': 'Primary Group',

  // ── Router health section ──────────────────────────────────────
  'settings.router.host.label': 'Host',
  'settings.router.host.hint': '路由器内网地址',
  'settings.router.host.placeholder': '192.168.1.1',
  'settings.router.port.label': 'Port',
  'settings.router.port.hint': '1 - 65535',

  // ── Refresh interval fields ────────────────────────────────────
  // Source: `INTERVAL_META` in SettingsView.tsx. Six label/hint
  // pairs — one per RefreshIntervalSettings key.
  'settings.intervals.network.label': '网络',
  'settings.intervals.network.hint': '路由 + 外网探测',
  'settings.intervals.openclash.label': 'OpenClash',
  'settings.intervals.openclash.hint': 'API / 模式轮询',
  'settings.intervals.currentNode.label': '当前节点',
  'settings.intervals.currentNode.hint': '延迟与丢包采样',
  'settings.intervals.nodeScan.label': '节点扫描',
  'settings.intervals.nodeScan.hint': '全量节点列表',
  'settings.intervals.usage.label': 'AI 用量',
  'settings.intervals.usage.hint': 'Token / 配额刷新',
  'settings.intervals.retention.label': '清理',
  'settings.intervals.retention.hint': '历史数据保留',

  // ── Switching section ──────────────────────────────────────────
  'settings.switching.verifyDelay.label': '验证延迟',
  'settings.switching.verifyDelay.hint':
    '切换后等待节点稳定的时间 (0 - 10000 ms)',
  'settings.switching.confirm.label': '切换前确认',
  'settings.switching.confirm.hint': '切换到不同节点时弹出二次确认',

  // ── Management interface section ───────────────────────────────
  'settings.management.url.label': 'LuCI URL',
  'settings.management.url.hint':
    'OpenWrt LuCI 面板地址 (http(s)://host[:port])，留空表示未配置',
  'settings.management.url.placeholder': 'http://192.168.31.100',
  'settings.management.requestTimeout.label': '请求超时',
  'settings.management.requestTimeout.hint':
    '管理接口单次请求超时 (1000 - 30000 ms)',
  'settings.management.verifyWindow.label': '配置切换校验窗口',
  'settings.management.verifyWindow.hint':
    '切换配置后等待 Clash 内核完成重载的时间 (1000 - 30000 ms)',
  'settings.management.username.label': 'LuCI 用户名',
  'settings.management.username.hint': '留空则保留现有凭据',
  'settings.management.username.placeholder': '留空则保留现有用户名',
  'settings.management.password.label': 'LuCI 密码',
  'settings.management.password.hint': '仅写入；保存后清空，不显示当前值',
  'settings.management.password.placeholder': '留空则保留现有密码',
  'settings.management.password.showAria': '显示密码',
  'settings.management.password.hideAria': '隐藏密码',
  'settings.management.clearCredentials': '清除管理接口凭据',
  'settings.management.credentialsCleared': '已清除存储的凭据',
  'settings.management.whitelist.label': '配置文件白名单',
  'settings.management.whitelist.hint':
    '手工维护的可切换 OpenClash 配置文件列表 (路径需形如 /etc/openclash/config/*.yaml)',
  'settings.management.whitelist.empty': '尚未配置任何条目',
  'settings.management.whitelist.aliasPlaceholder': '别名 (例如 备用机场)',
  'settings.management.whitelist.pathPlaceholder':
    '/etc/openclash/config/example.yaml',
  'settings.management.whitelist.aliasAria': '配置文件别名 {n}',
  'settings.management.whitelist.pathAria': '配置文件路径 {n}',
  'settings.management.whitelist.deleteAria': '删除白名单条目 {n}',
  'settings.management.whitelist.addLabel': '添加白名单条目',

  // ── AI accounts (Provider_Auth) section ────────────────────────
  // Source: SettingsView.tsx accounts Section + manual API-key form.
  'settings.accounts.providerType.label': '账号类型 (auth 认证)',
  'settings.accounts.providerType.hint': '选择这份 auth 认证文件对应的服务',
  'settings.accounts.providerType.aria': '账号类型 (auth 认证)',
  'settings.accounts.actions.label': '操作',
  'settings.accounts.actions.hint':
    '主进程打开文件选择器，不向页面暴露 token / API key',
  'settings.accounts.actions.edit': '编辑',
  'settings.accounts.edit.secretPlaceholder': '留空则保留当前值',
  'settings.accounts.edit.reimport': '重新选择认证文件',
  'settings.accounts.edit.cancel': '取消编辑',
  'settings.accounts.import.label': '导入 auth 认证文件',
  'settings.accounts.import.busy': '导入中…',
  'settings.accounts.apiKey.openForm': '输入 API Key',
  'settings.accounts.apiKey.closeForm': '收起 API Key 表单',
  'settings.accounts.apiKey.providerLabel': '账号类型',
  'settings.accounts.apiKey.providerHint':
    '只支持纯 API key 的服务；OAuth 类账号请使用 auth 认证文件导入',
  'settings.accounts.apiKey.providerAria': 'API key 账号类型',
  'settings.accounts.apiKey.displayName.label': '显示名称',
  'settings.accounts.apiKey.displayName.hint': '可选；留空使用默认名称',
  'settings.accounts.apiKey.displayName.placeholder': '例如 主账号 / 备用 key',
  'settings.accounts.apiKey.value.label': 'API Key',
  'settings.accounts.apiKey.value.hint': '保存后即加密落库；保存成功不再回显',
  'settings.accounts.apiKey.value.placeholder': 'sk-...',
  'settings.accounts.apiKey.value.showAria': '显示 API key',
  'settings.accounts.apiKey.value.hideAria': '隐藏 API key',
  'settings.accounts.apiKey.baseUrl.label': 'Base URL',
  'settings.accounts.apiKey.baseUrl.hint': '必填，例如 https://api.example.com/v1',
  'settings.accounts.apiKey.baseUrl.placeholder': 'https://...',
  // The submit button toggles between `保存账号` and `保存中…`; the
  // type comments in `types.ts` refer to the older `添加账号` copy
  // which has since been renamed in SettingsView.tsx. The catalog
  // tracks the live UI string.
  'settings.accounts.apiKey.submit': '保存账号',
  'settings.accounts.apiKey.submitting': '保存中…',
  'settings.accounts.apiKey.validation.empty': 'API key 不能为空',
  'settings.accounts.apiKey.validation.baseUrlRequired':
    'OpenAI 兼容账号必须填写 Base URL',
  'settings.accounts.apiKey.validation.xiaomiRequired':
    '小米 Mimo 必须填写 passToken 和 userId',
  'settings.accounts.apiKey.validation.opencodeRequired':
    'OpenCode Go 必须填写 auth cookie 和 workspace URL',
  'settings.accounts.apiKey.error.unknown': '未知错误',
  'settings.accounts.apiKey.error.importFailed': '导入失败 ({code})',
  'settings.accounts.apiKey.error.prefix': '{label}：{message}',

  // ── NodeTable — region buckets ─────────────────────────────────
  // Source: REGION_BUCKETS / OTHER_BUCKET in NodeTable.tsx.
  'node.region.hk': '香港',
  'node.region.tw': '台湾',
  'node.region.jp': '日本',
  'node.region.us': '美国',
  'node.region.other': '其他',

  // ── NodeTable — chrome and per-row affordances ─────────────────
  'node.empty': '暂无节点数据',
  'node.activePill': '当前',
  'node.action.switch': '切换',
  'node.action.switching': '切换中…',
  'node.action.failed': '切换失败',
  'node.action.unknownError': '切换发生未知错误',
  'node.bridge.missing': 'desktop bridge 不可用',
  'node.statusAria': '状态 {tone}',
  'node.statusTitle': '状态：{tone}',
  'node.latencyTitle': '延迟 {value}',
  'node.successRateTitle': '成功率 {value}',
  'node.confirmSwitchPrompt': '确认切换到节点「{name}」？',

  // ── QuickNodeCard ──────────────────────────────────────────────
  'quickNode.aria': '快速节点切换',
  'quickNode.unknownGroup': '未识别主组',
  'quickNode.unselectedNode': '未选择节点',
  'quickNode.currentLabel': '当前节点',
  'quickNode.empty': '暂无可推荐节点',

  // ── ConfigSwitchCard ───────────────────────────────────────────
  'configSwitch.aria': 'OpenClash 配置切换',
  'configSwitch.eyebrow': '配置切换',
  'configSwitch.unnamed': '(未命名配置)',
  'configSwitch.disable.inProgress': '配置切换进行中…',
  'configSwitch.disable.homeDown': '路由器不可达，无法执行切换',
  'configSwitch.disable.notConfigured':
    'OpenClash 管理接口未配置，请前往设置页填写地址与凭据',
  'configSwitch.disable.unreachable': 'OpenClash 管理接口不可达',
  'configSwitch.guidance':
    '未从 OpenClash 读取到配置文件。请检查管理接口地址和凭据是否正确。',
  'configSwitch.activeBadge': '生效',

  // ── ConfirmDialog ──────────────────────────────────────────────
  'confirmDialog.title': '确认切换 OpenClash 配置文件',
  'confirmDialog.warning': '切换将重启 Clash 内核并断开所有现有连接',
  'confirmDialog.startLabel': '当前配置：',
  'confirmDialog.targetLabel': '目标配置：',
  'confirmDialog.cancel': '取消',
  'confirmDialog.confirm': '确认切换',
  'confirmDialog.unknown': '未知',

  // ── QuickActionsPanel banners + chrome ─────────────────────────
  // Source: QuickActionsPanel.tsx `selectBanner`.
  'quickActions.aria': '快捷动作',
  'quickActions.banner.homeDown.headline': '家庭离线',
  'quickActions.banner.homeDown.detail':
    '路由器不可达，所有切换都会失败；请检查家中网络与路由器电源',
  'quickActions.banner.managementFailures.headline': '管理接口持续失败',
  'quickActions.banner.managementFailures.detail':
    'OpenClash 管理接口已连续失败 5 次以上，请检查凭据或网络',
  'quickActions.banner.managementUnreachable.headline': '管理接口不可达',
  'quickActions.banner.managementUnreachable.detail':
    'OpenClash 管理接口暂时无法连接；切换操作将不可用',
  'quickActions.banner.kernelUnreachable.headline': '内核暂不可达',
  'quickActions.banner.kernelUnreachable.detail':
    'OpenClash 内核暂时无响应，可尝试切换配置以恢复',
  'quickActions.banner.credsError.headline': '凭据错误',
  'quickActions.banner.networkDegraded.headline': '网络降级',
  'quickActions.banner.networkDegraded.detail':
    '当前节点出现降级，建议切换节点或配置',
  // Banner aria-label template: `${headline}：${detail}`.
  'quickActions.banner.ariaTemplate': '{headline}：{detail}',
  'quickActions.lastConfigSwitchPrefix': '上次配置切换：',
  'quickActions.switchUnknownError': '切换配置时发生未知错误',

  // ── Management error labels (renderer/lib/format.ts) ───────────
  // Mirror of MANAGEMENT_ERROR_LABELS in renderer/lib/format.ts —
  // funnelled through Translation_Function in tasks 14.4–14.5 so
  // banners, inline errors, and last-switch hints share copy.
  'management.error.auth': 'OpenClash 凭据未配置或不正确',
  'management.error.http': 'OpenClash 管理接口返回错误',
  'management.error.network': 'OpenClash 管理接口无法连接',
  'management.error.verifyTimeout': '配置切换验证超时',
  'management.error.verifyMismatch': '配置切换验证失败',
  'management.error.notSupported': '当前部署形态不支持此操作',
  'management.error.switchInProgress': '另一项切换正在进行中',

  // ── Compact widget — WidgetShell chrome ────────────────────────
  // Source: `WidgetShell.tsx` `nodeLine` + section aria-labels.
  'compact.network.aria': '网络状态',
  'compact.usage.aria': 'AI 用量',
  'compact.shrink.title': '切换到极简模式',
  'compact.shrink.aria': '切换到极简模式',
  'compact.unselectedReal.primary': '未选择真实节点',
  'compact.unselectedReal.tooltip': '{group} 当前选择为 DIRECT/GLOBAL/REJECT',
  'compact.waitingNode.primary': '等待节点数据',
  'compact.waitingNode.tooltip': '当前节点暂无数据',

  // ── CompactMiniRail — quota tooltip / aria templates ───────────
  // Source: `buildBadgeTitle` in CompactMiniRail.tsx.
  'compactMiniRail.quotaUnknown': '{label} · 额度未知',
  'compactMiniRail.quotaPair.fiveH': '5h {pct}%',
  'compactMiniRail.quotaPair.weekly': '周 {pct}%',
  'compactMiniRail.quotaPair.effective': '实际 {pct}%',
  'compactMiniRail.quotaSingle': '{label} · {pct}%',

  // ── StatusHero ─────────────────────────────────────────────────
  // Source: `StatusHero.tsx` fail-count badge `失败${failCount}`.
  'statusHero.failsBadge': '失败{count}',

  // ── QuotaStrip / UsagePanel — time-range labels ────────────────
  // Source: `RANGE_OPTIONS` in UsagePanel.tsx.
  'usage.range.today': '今日',
  'usage.range.week': '本周',
  'usage.range.month': '本月',

  // ── Quota window names (renderer/lib/quota-display.ts) ─────────
  // Closed enumeration of the synthetic quota-window display names
  // produced by `quotaWindowDisplayName` and the OpenCode Go /
  // Kiro IDE provider-specific overrides.
  'quota.window.fiveH': '5 小时限额',
  'quota.window.daily': '日限额',
  'quota.window.weekly': '周限额',
  'quota.window.monthly': '月限额',
  'quota.window.rollingUsage': '滚动用量',
  'quota.window.weeklyUsage': '每周用量',
  'quota.window.monthlyUsage': '每月用量',
  'quota.window.monthlyAllowance': '月度额度',
  'quota.window.creditsFallback': '额度积分',

  // Compact-rail short forms (`quotaWindowCompactLabel`).
  'quota.window.short.fiveH': '5h',
  'quota.window.short.weekly': '周',
  'quota.window.short.monthly': '月',
  'quota.window.short.daily': '日',

  // ── QuotaSnapshot status badges ───────────────────────────────
  // Source: `snapshotStatusLabel` in UsagePanel.tsx.
  'quota.snapshot.authExpired': '凭据过期',
  'quota.snapshot.upstreamRefused': '上游拒绝',
  'quota.snapshot.rateLimited': '请求过快',
  'quota.snapshot.useLastResult': '使用上次结果',
  'quota.snapshot.unavailable': '不可用',
  'quota.snapshot.unsupported': '暂不支持',
  'quota.snapshot.normal': '正常',

  // ── QuotaSnapshot.source labels ───────────────────────────────
  // Source: `sourceDisplayName` in UsagePanel.tsx.
  'quota.source.importedAuth': 'auth 认证',
  'quota.source.remoteApi': '官方 API',
  'quota.source.localLog': '本地日志',
  'quota.source.healthCheck': '健康检查',
  'quota.source.manualApiKey': '手动 API Key',

  // ── Plan-label prefixes (UsagePanel `planLabelPrefix`) ─────────
  'usage.plan.tier': '层级',
  'usage.plan.package': '套餐',

  // Identity-prefix wrappers in UsagePanel (`项目 ${id}` /
  // `账号 ${id}` next to the plan chip).
  'usage.identityPrefix.project': '项目 {value}',
  'usage.identityPrefix.account': '账号 {value}',

  // ── QuotaStrip — credits summary ──────────────────────────────
  // Source: `CreditsRowItem` in QuotaStrip.tsx and the credits
  // breakdown formatter in UsagePanel.tsx.
  'quota.credits.balanceLabel': '余额',
  'quota.credits.totalPrefix': '总额 {value}',
  'quota.credits.cashPrefix': '现金 {value}',
  'quota.credits.grantedPrefix': '赠金 {value}',
  'quota.credits.toppedUpPrefix': '充值 {value}',
  'quota.credits.sparklineAria': '近期 14 天每日用量',

  // ── UsagePanel — chart kind labels ────────────────────────────
  // Source: UsageBarChart kind buckets surfaced through UsagePanel.
  'usage.kind.output': '输出',
  'usage.kind.input': '输入',
  'usage.kind.cache': '缓存',
  'usage.kind.legendAria': '柱体内深浅色对应：输出 / 输入 / 缓存',

  // ── UsagePanel — empty-state sentences ────────────────────────
  'usage.empty.allRanges': '所有时段无可用数据',
  'usage.empty.hoverHint': '悬停或聚焦柱体查看详细数据',
  'usage.empty.todayPlaceholder': '今日内若产生使用，会按小时显示在此。',
  'usage.empty.rangePlaceholder': '该区间一旦产生使用，会按天显示在此。',

  // ── UsagePanel — chrome / loading / error ─────────────────────
  'usage.panel.aria': 'AI 用量面板',
  'usage.panel.title': 'Token 消耗',
  'usage.panel.rangeAria': '时间范围',
  'usage.panel.loading': '加载中…',
  'usage.chart.localToken': '本地 Token 用量',
  'usage.chart.apiUsage': 'API 用量明细',
  'usage.overview.title': '配额状态',
  'usage.overview.accountSuffix': '{count} 个账号',
  'usage.account.typeAuth': 'auth 认证',
  'usage.account.typeApiKey': '手动 API Key',

  // ── ProviderAuthList — capability + error labels ──────────────
  // Source: CAPABILITY_LABELS / PROVIDER_AUTH_ERROR_LABELS in
  // src/renderer/components/ProviderAuthList.tsx.
  'providerAuth.capability.official': '官方 Quota',
  'providerAuth.capability.healthOnly': '可用性检查',
  'providerAuth.capability.usageOnly': '本地用量',
  'providerAuth.capability.unsupported': '未支持',

  'providerAuth.error.authMissing': '凭据缺失',
  'providerAuth.error.authExpired': '凭据已过期',
  'providerAuth.error.projectMissing': '缺少项目 ID',
  'providerAuth.error.upstreamUnauthorized': '上游拒绝授权',
  'providerAuth.error.rateLimited': '上游限流',
  'providerAuth.error.upstreamChanged': '上游接口已变更',
  'providerAuth.error.networkError': '网络异常',
  'providerAuth.error.unsupported': '暂未实现 (v1.1 上线)',
  'providerAuth.error.parseError': '认证文件解析失败',
  'providerAuth.error.unsupportedFile': '不支持的文件类型',
};
