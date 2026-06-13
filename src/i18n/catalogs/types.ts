// Translation_Catalog shape — the single, exhaustive list of
// Translation_Keys for the i18n-multilingual-support feature.
//
// The interface is **closed** (no string index signature) on purpose:
//
//   1. Adding a new key here forces both `zh-CN.ts` and `en-US.ts` to
//      provide a value (otherwise tsc fails). This is the compile-time
//      half of Requirement 3.2 (catalog symmetry under tsc --noEmit).
//
//   2. Removing a key likewise removes both catalog entries, so
//      Requirement 3.3 (key-set symmetry) holds by construction.
//
//   3. Call sites benefit from autocomplete and rename refactor on the
//      key strings: `t('tray.menu.expand_typo')` is a tsc error, not a
//      runtime miss followed by a `console.warn`.
//
// The enumeration below covers every Translation_Key referenced in
// requirements.md Requirement 4.2 (renderer surface coverage),
// Requirement 5 (main-process surface coverage), and Requirement 6
// (health status pivot), plus the locale-picker keys introduced by
// Requirement 8. The actual zh-CN and en-US string values are filled
// in by tasks 1.2 and 1.3 — this file pins the shape only.

export interface TranslationCatalog {
  // -------------------------------------------------------------------
  // Tray context menu (Requirement 5.1, 5.2)
  // Source: src/main/tray.ts buildContextMenu().
  // -------------------------------------------------------------------
  'tray.menu.toggle': string;       // 显示/隐藏
  'tray.menu.expand': string;       // 展开
  'tray.menu.settings': string;     // 设置
  'tray.menu.pause': string;        // 暂停采集
  'tray.menu.resume': string;       // 继续
  'tray.menu.quit': string;         // 退出

  // -------------------------------------------------------------------
  // Dashboard health labels (Requirement 6.2, 6.4)
  // Six keys, one per HealthStatus enum value. zh-CN values must match
  // the current HEALTH_STATUS_LABELS map in dashboard.service.ts
  // byte-for-byte (Requirement 6.5).
  // -------------------------------------------------------------------
  'dashboard.health.healthy': string;
  'dashboard.health.node_slow': string;
  'dashboard.health.node_down': string;
  'dashboard.health.openclash_unreachable': string;
  'dashboard.health.home_down': string;
  'dashboard.health.partial_outage': string;

  // -------------------------------------------------------------------
  // Native dialog filters (Requirement 5.4)
  // Source: src/main/app.ts dialog.showOpenDialog filters array.
  // -------------------------------------------------------------------
  'dialog.openAuthFile.filter.cpaAuth': string;
  'dialog.openAuthFile.filter.all': string;

  // -------------------------------------------------------------------
  // Expanded window — tab labels and chrome (Requirement 4.2)
  // Source: src/renderer/App.tsx ExpandedRoot TABS / topbar / aria.
  // -------------------------------------------------------------------
  'expanded.tab.network': string;       // 网络
  'expanded.tab.usage': string;         // 用量
  'expanded.tab.settings': string;      // 设置
  'expanded.aria.mainNav': string;      // 主导航
  'expanded.aria.refreshNow': string;   // 立即刷新
  'expanded.refresh.title': string;     // 立即刷新

  // -------------------------------------------------------------------
  // Expanded window — Network tab card / panel chrome (Requirement 4.2)
  // -------------------------------------------------------------------
  'dashboard.network.cardAria': string;          // 网络状态
  'dashboard.network.eyebrow': string;           // network · 连通性 (English half stays)
  'dashboard.network.latencyRangeAria': string;  // 延迟区间
  'dashboard.network.liveAria': string;          // 实时数据
  'dashboard.network.liveTitle': string;         // 实时数据
  'dashboard.network.avgLatencyAria': string;    // 平均延迟
  'dashboard.network.waitingNodeData': string;   // 等待节点数据
  'dashboard.network.waitingData': string;       // 等待数据中…
  'dashboard.network.nodeListAria': string;      // 节点列表
  'dashboard.network.nodeTitle': string;         // 节点
  'dashboard.network.groupMeta': string;         // 分组
  'dashboard.network.groupSelectorAria': string; // 选择节点分组

  // -------------------------------------------------------------------
  // Renderer boot states (Requirement 4.2, 10.2)
  // The literal "preload bridge unavailable" stays locale-neutral
  // (Requirement 10.3) and is intentionally NOT a Translation_Key.
  // -------------------------------------------------------------------
  'boot.loading': string;             // 加载中…
  'boot.loadingSettings': string;     // 加载设置中…
  'boot.cannotLoadSettings': string;  // 无法加载设置
  'boot.waitingData': string;         // 等待数据中…
  'boot.waitingNodes': string;        // 等待节点数据

  // -------------------------------------------------------------------
  // SettingsView — section rail labels and hints (Requirement 4.2)
  // One pair per SECTIONS entry in src/renderer/components/SettingsView.tsx.
  // -------------------------------------------------------------------
  'settings.section.appearance.label': string;
  'settings.section.appearance.hint': string;
  'settings.section.controller.label': string;
  'settings.section.controller.hint': string;
  'settings.section.probes.label': string;
  'settings.section.probes.hint': string;
  'settings.section.groups.label': string;
  'settings.section.groups.hint': string;
  'settings.section.router.label': string;
  'settings.section.router.hint': string;
  'settings.section.intervals.label': string;
  'settings.section.intervals.hint': string;
  'settings.section.switching.label': string;
  'settings.section.switching.hint': string;
  'settings.section.management.label': string;
  'settings.section.management.hint': string;
  'settings.section.accounts.label': string;
  'settings.section.accounts.hint': string;

  // -------------------------------------------------------------------
  // SettingsView — chrome (root, navigation, save bar)
  // -------------------------------------------------------------------
  'settings.aria.root': string;          // 设置
  'settings.aria.nav': string;           // 设置导航
  'settings.action.save': string;        // 保存
  'settings.action.discard': string;     // 放弃修改
  'settings.action.saved': string;       // 已保存
  'settings.action.unknownError': string; // 未知错误
  'settings.save.unknownError': string;   // 清除凭据时发生未知错误

  // -------------------------------------------------------------------
  // Appearance section — color mode, font scale, compact zoom
  // -------------------------------------------------------------------
  'settings.appearance.colorMode.label': string;
  'settings.appearance.colorMode.hint': string;
  'settings.appearance.colorMode.dark': string;     // 深色
  'settings.appearance.colorMode.light': string;    // 浅色
  'settings.appearance.colorMode.aria': string;
  'settings.appearance.fontScale.label': string;
  'settings.appearance.fontScale.hint': string;
  'settings.appearance.fontScale.aria': string;
  'settings.appearance.compactZoom.label': string;
  'settings.appearance.compactZoom.hint': string;
  'settings.appearance.compactZoom.aria': string;
  // Compact-window theme card aria-label template, e.g. "悬浮窗主题：{name}".
  'settings.appearance.theme.cardAria': string;

  // -------------------------------------------------------------------
  // Appearance section — compact theme presets (Requirement 4.2)
  // One label/description pair per COMPACT_THEME_OPTIONS entry in
  // SettingsView.tsx (eleven presets across v1 and v2).
  // -------------------------------------------------------------------
  'settings.appearance.theme.liquidGlass.label': string;
  'settings.appearance.theme.liquidGlass.description': string;
  'settings.appearance.theme.materialYou.label': string;
  'settings.appearance.theme.materialYou.description': string;
  'settings.appearance.theme.softNeumorph.label': string;
  'settings.appearance.theme.softNeumorph.description': string;
  'settings.appearance.theme.paperDashboard.label': string;
  'settings.appearance.theme.paperDashboard.description': string;
  'settings.appearance.theme.mintMonitor.label': string;
  'settings.appearance.theme.mintMonitor.description': string;
  'settings.appearance.theme.deviceOled.label': string;
  'settings.appearance.theme.deviceOled.description': string;
  'settings.appearance.theme.obsidianGlass.label': string;
  'settings.appearance.theme.obsidianGlass.description': string;
  'settings.appearance.theme.auroraRing.label': string;
  'settings.appearance.theme.auroraRing.description': string;
  'settings.appearance.theme.holoGrid.label': string;
  'settings.appearance.theme.holoGrid.description': string;
  'settings.appearance.theme.liquidMetal.label': string;
  'settings.appearance.theme.liquidMetal.description': string;
  'settings.appearance.theme.signalPulse.label': string;
  'settings.appearance.theme.signalPulse.description': string;

  // -------------------------------------------------------------------
  // Locale picker (Requirement 8)
  //
  // Note: The two visible option labels (`中文（简体）` / `English`)
  // are intentionally inline-literal in SettingsView and NOT
  // Translation_Keys (Requirement 8.2). Only the Field label, hint,
  // and persist-failure error are localised here.
  // -------------------------------------------------------------------
  'settings.locale.label': string;
  'settings.locale.hint': string;
  'settings.locale.errorPersistFailed': string;

  // -------------------------------------------------------------------
  // Controller section
  // -------------------------------------------------------------------
  'settings.controller.url.label': string;
  'settings.controller.url.hint': string;
  'settings.controller.url.placeholder': string;
  'settings.controller.secret.label': string;
  'settings.controller.secret.hint': string;
  'settings.controller.secret.placeholder': string;
  'settings.controller.secret.showAria': string;
  'settings.controller.secret.hideAria': string;

  // Validation errors raised against managementUrl / controllerUrl /
  // probe URLs (Requirement 4.2 — "every settings field validation
  // error").
  'settings.validation.urlInvalid': string;       // 必须是 http(s):// 开头的合法 URL
  'settings.validation.urlScheme': string;        // 必须使用 http:// 或 https://
  'settings.validation.urlNoCreds': string;       // URL 不应包含用户名或密码
  'settings.validation.urlNoQuery': string;       // URL 不应包含 query 或 fragment

  // -------------------------------------------------------------------
  // Probes section
  // -------------------------------------------------------------------
  'settings.probes.placeholder': string;          // https://example.com
  'settings.probes.addLabel': string;             // 添加探测 URL
  'settings.probes.itemAria': string;             // Probe URL

  // -------------------------------------------------------------------
  // Primary groups section
  // -------------------------------------------------------------------
  'settings.groups.placeholder': string;          // group name
  'settings.groups.addLabel': string;             // 添加分组
  'settings.groups.itemAria': string;             // Primary Group

  // -------------------------------------------------------------------
  // Router health section
  // -------------------------------------------------------------------
  'settings.router.host.label': string;
  'settings.router.host.hint': string;
  'settings.router.host.placeholder': string;
  'settings.router.port.label': string;
  'settings.router.port.hint': string;

  // -------------------------------------------------------------------
  // Refresh interval fields (one label/hint pair per RefreshIntervalSettings key)
  // Source: INTERVAL_META in SettingsView.tsx.
  // -------------------------------------------------------------------
  'settings.intervals.network.label': string;
  'settings.intervals.network.hint': string;
  'settings.intervals.openclash.label': string;
  'settings.intervals.openclash.hint': string;
  'settings.intervals.currentNode.label': string;
  'settings.intervals.currentNode.hint': string;
  'settings.intervals.nodeScan.label': string;
  'settings.intervals.nodeScan.hint': string;
  'settings.intervals.usage.label': string;
  'settings.intervals.usage.hint': string;
  'settings.intervals.retention.label': string;
  'settings.intervals.retention.hint': string;

  // -------------------------------------------------------------------
  // Switching section
  // -------------------------------------------------------------------
  'settings.switching.verifyDelay.label': string;
  'settings.switching.verifyDelay.hint': string;
  'settings.switching.confirm.label': string;
  'settings.switching.confirm.hint': string;

  // -------------------------------------------------------------------
  // Management interface section
  // -------------------------------------------------------------------
  'settings.management.url.label': string;
  'settings.management.url.hint': string;
  'settings.management.url.placeholder': string;
  'settings.management.requestTimeout.label': string;
  'settings.management.requestTimeout.hint': string;
  'settings.management.verifyWindow.label': string;
  'settings.management.verifyWindow.hint': string;
  'settings.management.username.label': string;
  'settings.management.username.hint': string;
  'settings.management.username.placeholder': string;
  'settings.management.password.label': string;
  'settings.management.password.hint': string;
  'settings.management.password.placeholder': string;
  'settings.management.password.showAria': string;
  'settings.management.password.hideAria': string;
  'settings.management.clearCredentials': string;       // 清除管理接口凭据
  'settings.management.credentialsCleared': string;     // 已清除存储的凭据
  'settings.management.whitelist.label': string;        // 配置文件白名单
  'settings.management.whitelist.hint': string;
  'settings.management.whitelist.empty': string;        // 尚未配置任何条目
  'settings.management.whitelist.aliasPlaceholder': string;
  'settings.management.whitelist.pathPlaceholder': string;
  'settings.management.whitelist.aliasAria': string;    // 配置文件别名 {n}
  'settings.management.whitelist.pathAria': string;     // 配置文件路径 {n}
  'settings.management.whitelist.deleteAria': string;   // 删除白名单条目 {n}
  'settings.management.whitelist.addLabel': string;     // 添加白名单条目

  // -------------------------------------------------------------------
  // AI accounts (Provider_Auth) section
  // -------------------------------------------------------------------
  'settings.accounts.providerType.label': string;       // 账号类型 (auth 认证)
  'settings.accounts.providerType.hint': string;
  'settings.accounts.providerType.aria': string;
  'settings.accounts.actions.label': string;            // 操作
  'settings.accounts.actions.hint': string;
  'settings.accounts.actions.edit': string;             // 编辑
  'settings.accounts.edit.secretPlaceholder': string;   // 留空则保留当前值
  'settings.accounts.edit.reimport': string;            // 重新选择认证文件
  'settings.accounts.edit.cancel': string;              // 取消编辑
  'settings.accounts.import.label': string;             // 导入 auth 认证文件
  'settings.accounts.import.busy': string;              // 导入中…
  'settings.accounts.apiKey.openForm': string;          // 输入 API Key
  'settings.accounts.apiKey.closeForm': string;         // 收起 API Key 表单
  'settings.accounts.apiKey.providerLabel': string;     // 账号类型
  'settings.accounts.apiKey.providerHint': string;
  'settings.accounts.apiKey.providerAria': string;
  'settings.accounts.apiKey.displayName.label': string;
  'settings.accounts.apiKey.displayName.hint': string;
  'settings.accounts.apiKey.displayName.placeholder': string;
  'settings.accounts.apiKey.value.label': string;       // API Key
  'settings.accounts.apiKey.value.hint': string;
  'settings.accounts.apiKey.value.placeholder': string;
  'settings.accounts.apiKey.value.showAria': string;
  'settings.accounts.apiKey.value.hideAria': string;
  'settings.accounts.apiKey.baseUrl.label': string;
  'settings.accounts.apiKey.baseUrl.hint': string;
  'settings.accounts.apiKey.baseUrl.placeholder': string;
  'settings.accounts.apiKey.submit': string;            // 添加账号
  'settings.accounts.apiKey.submitting': string;        // 添加中…
  'settings.accounts.apiKey.validation.empty': string;  // API key 不能为空
  'settings.accounts.apiKey.validation.baseUrlRequired': string; // OpenAI 兼容账号必须填写 Base URL
  'settings.accounts.apiKey.validation.xiaomiRequired': string;  // 小米 Mimo 必须填写 passToken 和 userId
  'settings.accounts.apiKey.validation.opencodeRequired': string; // OpenCode Go 必须填写 auth cookie 和 workspace URL
  'settings.accounts.apiKey.error.unknown': string;     // 未知错误
  'settings.accounts.apiKey.error.importFailed': string; // 导入失败 ({code})
  'settings.accounts.apiKey.error.prefix': string;      // {label}：{message}

  // -------------------------------------------------------------------
  // NodeTable — region buckets (Requirement 4.2)
  // -------------------------------------------------------------------
  'node.region.hk': string;       // 香港
  'node.region.tw': string;       // 台湾
  'node.region.jp': string;       // 日本
  'node.region.us': string;       // 美国
  'node.region.other': string;    // 其他

  // -------------------------------------------------------------------
  // NodeTable — chrome and per-row affordances
  // -------------------------------------------------------------------
  'node.empty': string;                 // 暂无节点数据
  'node.activePill': string;            // 当前
  'node.action.switch': string;         // 切换
  'node.action.switching': string;      // 切换中…
  'node.action.failed': string;         // 切换失败
  'node.action.unknownError': string;   // 切换发生未知错误
  'node.bridge.missing': string;        // desktop bridge 不可用
  'node.statusAria': string;            // 状态 {tone}
  'node.statusTitle': string;           // 状态：{tone}
  'node.latencyTitle': string;          // 延迟 {value}
  'node.successRateTitle': string;      // 成功率 {value}
  'node.confirmSwitchPrompt': string;   // 确认切换到节点「{name}」？

  // -------------------------------------------------------------------
  // QuickNodeCard
  // -------------------------------------------------------------------
  'quickNode.aria': string;             // 快速节点切换
  'quickNode.unknownGroup': string;     // 未识别主组
  'quickNode.unselectedNode': string;   // 未选择节点
  'quickNode.currentLabel': string;     // 当前节点
  'quickNode.empty': string;            // 暂无可推荐节点

  // -------------------------------------------------------------------
  // ConfigSwitchCard
  // -------------------------------------------------------------------
  'configSwitch.aria': string;                  // OpenClash 配置切换
  'configSwitch.eyebrow': string;               // 配置切换
  'configSwitch.unnamed': string;               // (未命名配置)
  'configSwitch.disable.inProgress': string;    // 配置切换进行中…
  'configSwitch.disable.homeDown': string;      // 路由器不可达，无法执行切换
  'configSwitch.disable.notConfigured': string; // OpenClash 管理接口未配置...
  'configSwitch.disable.unreachable': string;   // OpenClash 管理接口不可达
  'configSwitch.guidance': string;              // 尚未配置可切换的 OpenClash 配置文件...
  'configSwitch.activeBadge': string;           // 生效

  // -------------------------------------------------------------------
  // ConfirmDialog (config switch confirmation)
  // -------------------------------------------------------------------
  'confirmDialog.title': string;        // 确认切换 OpenClash 配置文件
  'confirmDialog.warning': string;      // 切换将重启 Clash 内核并断开所有现有连接
  'confirmDialog.startLabel': string;   // 当前配置：
  'confirmDialog.targetLabel': string;  // 目标配置：
  'confirmDialog.cancel': string;       // 取消
  'confirmDialog.confirm': string;      // 确认切换
  'confirmDialog.unknown': string;      // 未知

  // -------------------------------------------------------------------
  // QuickActionsPanel — banners and chrome (Requirement 4.2)
  // -------------------------------------------------------------------
  'quickActions.aria': string;                          // 快捷动作
  'quickActions.banner.homeDown.headline': string;      // 家庭离线
  'quickActions.banner.homeDown.detail': string;
  'quickActions.banner.managementFailures.headline': string; // 管理接口持续失败
  'quickActions.banner.managementFailures.detail': string;
  'quickActions.banner.managementUnreachable.headline': string; // 管理接口不可达
  'quickActions.banner.managementUnreachable.detail': string;
  'quickActions.banner.kernelUnreachable.headline': string;     // 内核暂不可达
  'quickActions.banner.kernelUnreachable.detail': string;
  'quickActions.banner.credsError.headline': string;            // 凭据错误
  'quickActions.banner.networkDegraded.headline': string;       // 网络降级
  'quickActions.banner.networkDegraded.detail': string;
  'quickActions.banner.ariaTemplate': string;           // {headline}：{detail}
  'quickActions.lastConfigSwitchPrefix': string;        // 上次配置切换：
  'quickActions.switchUnknownError': string;            // 切换配置时发生未知错误

  // -------------------------------------------------------------------
  // Management error labels (renderer/lib/format.ts MANAGEMENT_ERROR_LABELS)
  // Funnelled through formatManagementError; one key per closed-set code.
  // -------------------------------------------------------------------
  'management.error.auth': string;              // OpenClash 凭据未配置或不正确
  'management.error.http': string;              // OpenClash 管理接口返回错误
  'management.error.network': string;           // OpenClash 管理接口无法连接
  'management.error.verifyTimeout': string;     // 配置切换验证超时
  'management.error.verifyMismatch': string;    // 配置切换验证失败
  'management.error.notSupported': string;      // 当前部署形态不支持此操作
  'management.error.switchInProgress': string;  // 另一项切换正在进行中

  // -------------------------------------------------------------------
  // Compact widget — WidgetShell chrome (Requirement 4.2)
  // -------------------------------------------------------------------
  'compact.network.aria': string;       // 网络状态
  'compact.usage.aria': string;         // AI 用量
  'compact.shrink.title': string;       // 切换到极简模式
  'compact.shrink.aria': string;
  'compact.unselectedReal.primary': string;  // 未选择真实节点
  'compact.unselectedReal.tooltip': string;  // {group} 当前选择为 DIRECT/GLOBAL/REJECT
  'compact.waitingNode.primary': string;     // 等待节点数据
  'compact.waitingNode.tooltip': string;     // 当前节点暂无数据

  // -------------------------------------------------------------------
  // CompactMiniRail — quota tooltip / aria
  // -------------------------------------------------------------------
  'compactMiniRail.quotaUnknown': string;       // {label} · 额度未知
  'compactMiniRail.quotaPair.fiveH': string;    // 5h {pct}%
  'compactMiniRail.quotaPair.weekly': string;   // 周 {pct}%
  'compactMiniRail.quotaPair.effective': string; // 实际 {pct}%
  'compactMiniRail.quotaSingle': string;        // {label} · {pct}%

  // -------------------------------------------------------------------
  // StatusHero (Requirement 6.2 — uses dashboard.health.* via t())
  // -------------------------------------------------------------------
  'statusHero.failsBadge': string;      // 失败{count}

  // -------------------------------------------------------------------
  // QuotaStrip / UsagePanel — time-range labels (Requirement 4.2)
  // -------------------------------------------------------------------
  'usage.range.today': string;          // 今日
  'usage.range.week': string;           // 本周
  'usage.range.month': string;          // 本月

  // -------------------------------------------------------------------
  // Quota window names (Requirement 4.2)
  // Closed enumeration of the synthetic quota-window display names
  // produced by renderer/lib/quota-display.ts.
  // -------------------------------------------------------------------
  'quota.window.fiveH': string;             // 5 小时限额
  'quota.window.daily': string;             // 日限额
  'quota.window.weekly': string;            // 周限额
  'quota.window.monthly': string;           // 月限额
  'quota.window.rollingUsage': string;      // 滚动用量
  'quota.window.weeklyUsage': string;       // 每周用量
  'quota.window.monthlyUsage': string;      // 每月用量
  'quota.window.monthlyAllowance': string;  // 月度额度
  'quota.window.creditsFallback': string;   // 额度积分

  // Short forms used in the compact rail (5h / 周 / 月 / 日).
  'quota.window.short.fiveH': string;
  'quota.window.short.weekly': string;
  'quota.window.short.monthly': string;
  'quota.window.short.daily': string;

  // -------------------------------------------------------------------
  // QuotaSnapshot status badges (Requirement 4.2)
  // -------------------------------------------------------------------
  'quota.snapshot.authExpired': string;       // 凭据过期
  'quota.snapshot.upstreamRefused': string;   // 上游拒绝
  'quota.snapshot.rateLimited': string;       // 请求过快
  'quota.snapshot.useLastResult': string;     // 使用上次结果
  'quota.snapshot.unavailable': string;       // 不可用
  'quota.snapshot.unsupported': string;       // 暂不支持
  'quota.snapshot.normal': string;            // 正常

  // -------------------------------------------------------------------
  // QuotaSnapshot.source labels (Requirement 4.2)
  // -------------------------------------------------------------------
  'quota.source.importedAuth': string;        // auth 认证
  'quota.source.remoteApi': string;           // 官方 API
  'quota.source.localLog': string;            // 本地日志
  'quota.source.healthCheck': string;         // 健康检查
  'quota.source.manualApiKey': string;        // 手动 API Key

  // -------------------------------------------------------------------
  // Plan-label prefixes used by UsagePanel
  // -------------------------------------------------------------------
  'usage.plan.tier': string;                  // 层级
  'usage.plan.package': string;               // 套餐

  // Prefix wrappers used by UsagePanel for project / account ids.
  'usage.identityPrefix.project': string;     // 项目 {value}
  'usage.identityPrefix.account': string;     // 账号 {value}

  // -------------------------------------------------------------------
  // QuotaStrip — credits summary (DeepSeek / Xiaomi balance rows)
  // -------------------------------------------------------------------
  'quota.credits.balanceLabel': string;       // 余额
  'quota.credits.totalPrefix': string;        // 总额 {value}
  'quota.credits.cashPrefix': string;         // 现金 {value}
  'quota.credits.grantedPrefix': string;      // 赠金 {value}
  'quota.credits.toppedUpPrefix': string;     // 充值 {value}
  'quota.credits.sparklineAria': string;      // 近期 14 天每日用量

  // -------------------------------------------------------------------
  // UsagePanel — chart kind labels (Requirement 4.2 — kind labels)
  // -------------------------------------------------------------------
  'usage.kind.output': string;                // 输出
  'usage.kind.input': string;                 // 输入
  'usage.kind.cache': string;                 // 缓存
  'usage.kind.legendAria': string;            // 柱体内深浅色对应：输出 / 输入 / 缓存

  // -------------------------------------------------------------------
  // UsagePanel — empty-state sentences (Requirement 4.2)
  // -------------------------------------------------------------------
  'usage.empty.allRanges': string;            // 所有时段无可用数据
  'usage.empty.hoverHint': string;            // 悬停或聚焦柱体查看详细数据
  'usage.empty.todayPlaceholder': string;     // 今日内若产生使用，会按小时显示在此。
  'usage.empty.rangePlaceholder': string;     // 该区间一旦产生使用，会按天显示在此。

  // -------------------------------------------------------------------
  // UsagePanel — chrome / loading / error
  // -------------------------------------------------------------------
  'usage.panel.aria': string;                 // AI 用量面板
  'usage.panel.title': string;                // Token 消耗
  'usage.panel.rangeAria': string;            // 时间范围
  'usage.panel.loading': string;              // 加载中…
  'usage.chart.localToken': string;           // 本地 Token 用量
  'usage.chart.apiUsage': string;             // API 用量明细
  'usage.overview.title': string;             // 配额状态
  'usage.overview.accountSuffix': string;     // {count} 个账号
  'usage.account.typeAuth': string;           // auth 认证
  'usage.account.typeApiKey': string;         // 手动 API Key

  // -------------------------------------------------------------------
  // UsageBarChart / UsagePanel i18n fixes
  // -------------------------------------------------------------------
  'usage.chart.metricCost': string;
  'usage.chart.metricTokens': string;
  'usage.chart.emptyCost': string;
  'usage.chart.emptyTokens': string;
  'usage.chart.estimatedValue': string;
  'usage.chart.ariaLabel': string;
  'usage.chart.granularityHourScale': string;
  'usage.chart.granularityDayScale': string;
  'usage.chart.perHour': string;
  'usage.chart.perDay': string;
  'usage.chart.periodCount': string;
  'usage.chart.peak': string;
  'usage.chart.rangeTotal': string;
  'usage.chart.colAriaCost': string;
  'usage.chart.colAriaTokens': string;
  'usage.chart.colAriaEventsSuffix': string;
  'usage.chart.requestSeries': string;
  'usage.chart.eventCount': string;

  'usage.card.ariaQuota': string;
  'usage.card.noQuotaData': string;
  'usage.window.ariaRemaining': string;
  'usage.window.resetSuffix': string;

  'usage.notice.deepseekUserTokenRequired': string;
  'usage.notice.xiaomiDailyUnavailable': string;


  // -------------------------------------------------------------------
  // ProviderAuthList — capability + error labels
  // -------------------------------------------------------------------
  'providerAuth.capability.official': string;     // 官方 Quota
  'providerAuth.capability.healthOnly': string;   // 可用性检查
  'providerAuth.capability.usageOnly': string;    // 本地用量
  'providerAuth.capability.unsupported': string;  // 未支持

  'providerAuth.error.authMissing': string;       // 凭据缺失
  'providerAuth.error.authExpired': string;       // 凭据已过期
  'providerAuth.error.projectMissing': string;    // 缺少项目 ID
  'providerAuth.error.upstreamUnauthorized': string; // 上游拒绝授权
  'providerAuth.error.rateLimited': string;       // 上游限流
  'providerAuth.error.upstreamChanged': string;   // 上游接口已变更
  'providerAuth.error.networkError': string;      // 网络异常
  'providerAuth.error.unsupported': string;       // 暂未实现 (v1.1 上线)
  'providerAuth.error.parseError': string;        // 认证文件解析失败
  'providerAuth.error.unsupportedFile': string;   // 不支持的文件类型
}

/**
 * Closed-set string union of all valid Translation_Keys.
 *
 * Use this type as the parameter type of every Translation_Function
 * call: `t('tray.menu.expand')` typechecks; a typo is a tsc error.
 */
export type TranslationKey = keyof TranslationCatalog;
