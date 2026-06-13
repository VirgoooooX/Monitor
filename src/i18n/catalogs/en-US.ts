// English (United States) Translation_Catalog.
//
// Every value is **human-authored**, never machine-translated, and
// drives the visible UI surfaces enumerated in
// .kiro/specs/i18n-multilingual-support/requirements.md §4.2 and §5.
//
// Invariants enforced by tasks 1.10 and 16 (build-time validator):
//
//   * Same key set as the zh-CN catalog (Requirement 3.3).
//   * Every value is `typeof === 'string'`, `trim().length >= 1`,
//     `length <= 500` (Requirement 3.4).
//   * No CJK code points anywhere in this file (Requirement 4.1):
//     U+3000–U+303F, U+3400–U+4DBF, U+4E00–U+9FFF.
//   * For every key whose zh-CN value contains CJK, this catalog's
//     value differs byte-for-byte (Requirement 3.5). Keys whose
//     zh-CN value is brand-only / placeholder-only / number-only and
//     contains no CJK (e.g. `'5h'`, `'group name'`, `'OpenClash'`,
//     `'http://192.168.1.1:9090'`) are intentionally byte-equal.
//
// Width and tone notes:
//
//   * `dashboard.health.*` is rendered in the compact rail's
//     StatusHero next to a status dot, latency pill, and fail badge.
//     The CJK source is 4 glyphs per label; English equivalents are
//     kept ≤ 16 ASCII characters so they continue to fit on the
//     ~300px "mini" rail without ellipsis. Lengthening any of these
//     six values must be paired with a re-measure on the mini rail.
//
//   * Tray menu labels follow Apple HIG / Windows convention
//     ("Show/Hide", "Quit") rather than literal back-translation of
//     the zh-CN copy ("Show/Hide", "Pause sampling", "Quit").

import type { TranslationCatalog } from './types';

export const enUS: TranslationCatalog = {
  // --------------------------------------------------------------------
  // Tray context menu (Requirement 5.1, 5.2)
  // --------------------------------------------------------------------
  'tray.menu.toggle': 'Show/Hide',
  'tray.menu.expand': 'Expand',
  'tray.menu.settings': 'Settings',
  'tray.menu.pause': 'Pause sampling',
  'tray.menu.resume': 'Resume',
  'tray.menu.quit': 'Quit',

  // --------------------------------------------------------------------
  // Dashboard health labels (Requirement 6.2, 6.4)
  // --------------------------------------------------------------------
  'dashboard.health.healthy': 'Online',
  'dashboard.health.node_slow': 'Node slow',
  'dashboard.health.node_down': 'Node down',
  'dashboard.health.openclash_unreachable': 'Core unreachable',
  'dashboard.health.home_down': 'Home offline',
  'dashboard.health.partial_outage': 'Partial outage',

  // --------------------------------------------------------------------
  // Native dialog filters (Requirement 5.4)
  // --------------------------------------------------------------------
  'dialog.openAuthFile.filter.cpaAuth': 'CPA auth files',
  'dialog.openAuthFile.filter.all': 'All files',

  // --------------------------------------------------------------------
  // Expanded window — tab labels and chrome (Requirement 4.2)
  // --------------------------------------------------------------------
  'expanded.tab.network': 'Network',
  'expanded.tab.usage': 'Usage',
  'expanded.tab.settings': 'Settings',
  'expanded.aria.mainNav': 'Main navigation',
  'expanded.aria.refreshNow': 'Refresh now',
  'expanded.refresh.title': 'Refresh now',

  // --------------------------------------------------------------------
  // Network tab card / panel chrome (Requirement 4.2)
  // --------------------------------------------------------------------
  'dashboard.network.cardAria': 'Network status',
  'dashboard.network.eyebrow': 'network · connectivity',
  'dashboard.network.latencyRangeAria': 'Latency range',
  'dashboard.network.liveAria': 'Live data',
  'dashboard.network.liveTitle': 'Live data',
  'dashboard.network.avgLatencyAria': 'Average latency',
  'dashboard.network.waitingNodeData': 'Waiting for node data',
  'dashboard.network.waitingData': 'Waiting for data…',
  'dashboard.network.nodeListAria': 'Node list',
  'dashboard.network.nodeTitle': 'Node',
  'dashboard.network.groupMeta': 'Group',
  'dashboard.network.groupSelectorAria': 'Select node group',

  // --------------------------------------------------------------------
  // Renderer boot states (Requirement 4.2, 10.2)
  // --------------------------------------------------------------------
  'boot.loading': 'Loading…',
  'boot.loadingSettings': 'Loading settings…',
  'boot.cannotLoadSettings': 'Cannot load settings',
  'boot.waitingData': 'Waiting for data…',
  'boot.waitingNodes': 'Waiting for node data',

  // --------------------------------------------------------------------
  // SettingsView — section rail labels and hints
  // --------------------------------------------------------------------
  'settings.section.appearance.label': 'Appearance',
  'settings.section.appearance.hint': 'Color mode and compact widget look',
  'settings.section.controller.label': 'Controller',
  'settings.section.controller.hint': 'OpenClash controller connection',
  'settings.section.probes.label': 'Probe targets',
  'settings.section.probes.hint': 'Internet connectivity URLs',
  'settings.section.groups.label': 'Primary groups',
  'settings.section.groups.hint': 'Display and switching',
  'settings.section.router.label': 'Router',
  'settings.section.router.hint': 'LAN health check',
  'settings.section.intervals.label': 'Refresh cadence',
  'settings.section.intervals.hint': 'Sampling intervals (ms)',
  'settings.section.switching.label': 'Switching',
  'settings.section.switching.hint': 'Node switch behavior',
  'settings.section.management.label': 'Management API',
  'settings.section.management.hint': 'OpenClash LuCI',
  'settings.section.accounts.label': 'AI accounts',
  'settings.section.accounts.hint': 'Import auth files or enter API keys',

  // --------------------------------------------------------------------
  // SettingsView — chrome (root, navigation, save bar)
  // --------------------------------------------------------------------
  'settings.aria.root': 'Settings',
  'settings.aria.nav': 'Settings navigation',
  'settings.action.save': 'Save',
  'settings.action.discard': 'Discard changes',
  'settings.action.saved': 'Saved',
  'settings.action.unknownError': 'Unknown error',
  'settings.save.unknownError': 'Unknown error while clearing credentials',

  // --------------------------------------------------------------------
  // Appearance section — color mode, font scale, compact zoom
  // --------------------------------------------------------------------
  'settings.appearance.colorMode.label': 'Color mode',
  'settings.appearance.colorMode.hint':
    'Affects the expanded window only; the compact widget uses its own theme below.',
  'settings.appearance.colorMode.dark': 'Dark',
  'settings.appearance.colorMode.light': 'Light',
  'settings.appearance.colorMode.aria': 'Color mode',
  'settings.appearance.fontScale.label': 'Interface font size',
  'settings.appearance.fontScale.hint':
    'Scales headings, body text, buttons, tables, and inputs across the expanded window.',
  'settings.appearance.fontScale.aria': 'Interface font scale',
  'settings.appearance.compactZoom.label': 'Compact widget zoom',
  'settings.appearance.compactZoom.hint':
    'Magnifies the compact widget on high-density displays and resizes the window proportionally.',
  'settings.appearance.compactZoom.aria': 'Compact widget zoom',
  'settings.appearance.theme.cardAria': 'Compact widget theme: {name}',

  // --------------------------------------------------------------------
  // Compact theme presets (Requirement 4.2)
  // Eleven presets across v1 and v2; one label/description per entry.
  // --------------------------------------------------------------------
  'settings.appearance.theme.liquidGlass.label': 'Liquid Glass',
  'settings.appearance.theme.liquidGlass.description':
    'Light translucent glass — desktop-widget clarity.',
  'settings.appearance.theme.materialYou.label': 'Material You',
  'settings.appearance.theme.materialYou.description':
    'Light MD3 dual-color blocks; modern and approachable.',
  'settings.appearance.theme.softNeumorph.label': 'Soft Neumorphism',
  'settings.appearance.theme.softNeumorph.description':
    'Light raised shell with inset wells; quiet and low-noise.',
  'settings.appearance.theme.paperDashboard.label': 'Paper Dashboard',
  'settings.appearance.theme.paperDashboard.description':
    'Near-white paper surface with hairline dividers; office-friendly.',
  'settings.appearance.theme.mintMonitor.label': 'Mint Monitor',
  'settings.appearance.theme.mintMonitor.description':
    'Dark translucent cards in the original reference style.',
  'settings.appearance.theme.deviceOled.label': 'Device OLED',
  'settings.appearance.theme.deviceOled.description':
    'Metal chassis, black OLED panel, and LED segment bars.',
  'settings.appearance.theme.obsidianGlass.label': 'Obsidian Glass',
  'settings.appearance.theme.obsidianGlass.description':
    'Dark frosted texture; unobtrusive on busy desktops.',
  'settings.appearance.theme.auroraRing.label': 'Aurora Ring',
  'settings.appearance.theme.auroraRing.description':
    'Slow-flowing aurora along the border; strong status-color cue.',
  'settings.appearance.theme.holoGrid.label': 'Holo Grid',
  'settings.appearance.theme.holoGrid.description':
    'HUD-style grid with a slow scanline pass.',
  'settings.appearance.theme.liquidMetal.label': 'Liquid Metal',
  'settings.appearance.theme.liquidMetal.description':
    'Graphite finish with cool sheen; pairs with dark desktops.',
  'settings.appearance.theme.signalPulse.label': 'Signal Pulse',
  'settings.appearance.theme.signalPulse.description':
    'Concentric rings pulsing in the active status color.',

  // --------------------------------------------------------------------
  // Locale picker (Requirement 8)
  // --------------------------------------------------------------------
  'settings.locale.label': 'Language',
  'settings.locale.hint':
    'Applies live to both windows and the tray menu without restart.',
  'settings.locale.errorPersistFailed':
    'Could not save your language preference. Please try again.',

  // --------------------------------------------------------------------
  // Controller section
  // --------------------------------------------------------------------
  'settings.controller.url.label': 'Controller URL',
  'settings.controller.url.hint':
    'OpenClash main controller endpoint — must start with http(s)://.',
  'settings.controller.url.placeholder': 'http://192.168.1.1:9090',
  'settings.controller.secret.label': 'Secret',
  'settings.controller.secret.hint':
    'Write-only; cleared after save and never shown again.',
  'settings.controller.secret.placeholder': 'Leave blank to keep the existing secret',
  'settings.controller.secret.showAria': 'Show secret',
  'settings.controller.secret.hideAria': 'Hide secret',

  // Validation errors against management/controller/probe URLs.
  'settings.validation.urlInvalid':
    'Must be a valid URL starting with http:// or https://',
  'settings.validation.urlScheme': 'Must use http:// or https://',
  'settings.validation.urlNoCreds': 'URL must not contain a username or password',
  'settings.validation.urlNoQuery': 'URL must not contain a query or fragment',

  // --------------------------------------------------------------------
  // Probes section
  // --------------------------------------------------------------------
  'settings.probes.placeholder': 'https://example.com',
  'settings.probes.addLabel': 'Add probe URL',
  'settings.probes.itemAria': 'Probe URL',

  // --------------------------------------------------------------------
  // Primary groups section
  // --------------------------------------------------------------------
  'settings.groups.placeholder': 'group name',
  'settings.groups.addLabel': 'Add group',
  'settings.groups.itemAria': 'Primary Group',

  // --------------------------------------------------------------------
  // Router health section
  // --------------------------------------------------------------------
  'settings.router.host.label': 'Host',
  'settings.router.host.hint': 'Router LAN address',
  'settings.router.host.placeholder': '192.168.1.1',
  'settings.router.port.label': 'Port',
  'settings.router.port.hint': '1 – 65535',

  // --------------------------------------------------------------------
  // Refresh interval fields
  // --------------------------------------------------------------------
  'settings.intervals.network.label': 'Network',
  'settings.intervals.network.hint': 'Router + internet probes',
  'settings.intervals.openclash.label': 'OpenClash',
  'settings.intervals.openclash.hint': 'API and mode polling',
  'settings.intervals.currentNode.label': 'Current node',
  'settings.intervals.currentNode.hint': 'Latency and loss sampling',
  'settings.intervals.nodeScan.label': 'Node scan',
  'settings.intervals.nodeScan.hint': 'Full proxy node list',
  'settings.intervals.usage.label': 'AI usage',
  'settings.intervals.usage.hint': 'Token and quota refresh',
  'settings.intervals.retention.label': 'Retention',
  'settings.intervals.retention.hint': 'Historical data cleanup',

  // --------------------------------------------------------------------
  // Switching section
  // --------------------------------------------------------------------
  'settings.switching.verifyDelay.label': 'Verify delay',
  'settings.switching.verifyDelay.hint':
    'Time to wait for the new node to settle after a switch (0 – 10000 ms).',
  'settings.switching.confirm.label': 'Confirm before switching',
  'settings.switching.confirm.hint':
    'Show a confirmation dialog before switching to a different node.',

  // --------------------------------------------------------------------
  // Management interface section
  // --------------------------------------------------------------------
  'settings.management.url.label': 'LuCI URL',
  'settings.management.url.hint':
    'OpenWrt LuCI panel address (http(s)://host[:port]); leave blank if unconfigured.',
  'settings.management.url.placeholder': 'http://192.168.31.100',
  'settings.management.requestTimeout.label': 'Request timeout',
  'settings.management.requestTimeout.hint':
    'Single-request timeout for the management API (1000 – 30000 ms).',
  'settings.management.verifyWindow.label': 'Config switch verification window',
  'settings.management.verifyWindow.hint':
    'How long to wait for the Clash core to finish reloading after a config switch (1000 – 30000 ms).',
  'settings.management.username.label': 'LuCI username',
  'settings.management.username.hint': 'Leave blank to keep the existing credentials.',
  'settings.management.username.placeholder': 'Leave blank to keep the existing username',
  'settings.management.password.label': 'LuCI password',
  'settings.management.password.hint':
    'Write-only; cleared after save and never shown again.',
  'settings.management.password.placeholder': 'Leave blank to keep the existing password',
  'settings.management.password.showAria': 'Show password',
  'settings.management.password.hideAria': 'Hide password',
  'settings.management.clearCredentials': 'Clear management API credentials',
  'settings.management.credentialsCleared': 'Stored credentials cleared',
  'settings.management.whitelist.label': 'Config file allowlist',
  'settings.management.whitelist.hint':
    'Hand-maintained list of switchable OpenClash config files (paths must look like /etc/openclash/config/*.yaml).',
  'settings.management.whitelist.empty': 'No entries configured yet',
  'settings.management.whitelist.aliasPlaceholder': 'Alias (e.g. backup provider)',
  'settings.management.whitelist.pathPlaceholder':
    '/etc/openclash/config/example.yaml',
  'settings.management.whitelist.aliasAria': 'Config file alias {n}',
  'settings.management.whitelist.pathAria': 'Config file path {n}',
  'settings.management.whitelist.deleteAria': 'Delete allowlist entry {n}',
  'settings.management.whitelist.addLabel': 'Add allowlist entry',

  // --------------------------------------------------------------------
  // AI accounts (Provider_Auth) section
  // --------------------------------------------------------------------
  'settings.accounts.providerType.label': 'Account type (auth file)',
  'settings.accounts.providerType.hint':
    'Choose which service this auth file belongs to.',
  'settings.accounts.providerType.aria': 'Account type (auth file)',
  'settings.accounts.actions.label': 'Actions',
  'settings.accounts.actions.hint':
    'The main process opens the file picker; tokens and API keys are never exposed to the page.',
  'settings.accounts.actions.edit': 'Edit',
  'settings.accounts.edit.secretPlaceholder': 'Leave empty to keep current value',
  'settings.accounts.edit.reimport': 'Re-select auth file',
  'settings.accounts.edit.cancel': 'Cancel edit',
  'settings.accounts.import.label': 'Import auth file',
  'settings.accounts.import.busy': 'Importing…',
  'settings.accounts.apiKey.openForm': 'Enter API key',
  'settings.accounts.apiKey.closeForm': 'Hide API key form',
  'settings.accounts.apiKey.providerLabel': 'Account type',
  'settings.accounts.apiKey.providerHint':
    'Only services that accept a plain API key; OAuth-style accounts must use the auth-file import.',
  'settings.accounts.apiKey.providerAria': 'API key account type',
  'settings.accounts.apiKey.displayName.label': 'Display name',
  'settings.accounts.apiKey.displayName.hint':
    'Optional; leave blank to use the default name.',
  'settings.accounts.apiKey.displayName.placeholder':
    'e.g. main account / backup key',
  'settings.accounts.apiKey.value.label': 'API Key',
  'settings.accounts.apiKey.value.hint':
    'Encrypted at rest on save; not echoed back after a successful save.',
  'settings.accounts.apiKey.value.placeholder': 'sk-…',
  'settings.accounts.apiKey.value.showAria': 'Show API key',
  'settings.accounts.apiKey.value.hideAria': 'Hide API key',
  'settings.accounts.apiKey.baseUrl.label': 'Base URL',
  'settings.accounts.apiKey.baseUrl.hint':
    'Required, e.g. https://api.example.com/v1',
  'settings.accounts.apiKey.baseUrl.placeholder':
    'https://api.example.com/v1',
  'settings.accounts.apiKey.submit': 'Add account',
  'settings.accounts.apiKey.submitting': 'Adding…',
  'settings.accounts.apiKey.validation.empty': 'API key cannot be empty',
  'settings.accounts.apiKey.validation.baseUrlRequired':
    'OpenAI-compatible accounts require a Base URL',
  'settings.accounts.apiKey.validation.xiaomiRequired':
    'Xiaomi MiMo requires both passToken and userId',
  'settings.accounts.apiKey.validation.opencodeRequired':
    'OpenCode Go requires both an auth cookie and a workspace URL',
  'settings.accounts.apiKey.error.unknown': 'Unknown error',
  'settings.accounts.apiKey.error.importFailed': 'Import failed ({code})',
  'settings.accounts.apiKey.error.prefix': '{label}: {message}',

  // --------------------------------------------------------------------
  // NodeTable — region buckets (Requirement 4.2)
  // --------------------------------------------------------------------
  'node.region.hk': 'Hong Kong',
  'node.region.tw': 'Taiwan',
  'node.region.jp': 'Japan',
  'node.region.us': 'United States',
  'node.region.other': 'Other',

  // --------------------------------------------------------------------
  // NodeTable — chrome and per-row affordances
  // --------------------------------------------------------------------
  'node.empty': 'No node data yet',
  'node.activePill': 'Active',
  'node.action.switch': 'Switch',
  'node.action.switching': 'Switching…',
  'node.action.failed': 'Switch failed',
  'node.action.unknownError': 'Unknown error during switch',
  'node.bridge.missing': 'desktop bridge unavailable',
  'node.statusAria': 'Status: {tone}',
  'node.statusTitle': 'Status: {tone}',
  'node.latencyTitle': 'Latency {value}',
  'node.successRateTitle': 'Success rate {value}',
  'node.confirmSwitchPrompt': 'Switch to node "{name}"?',

  // --------------------------------------------------------------------
  // QuickNodeCard
  // --------------------------------------------------------------------
  'quickNode.aria': 'Quick node switch',
  'quickNode.unknownGroup': 'Primary group not detected',
  'quickNode.unselectedNode': 'No node selected',
  'quickNode.currentLabel': 'Current node',
  'quickNode.empty': 'No recommended nodes available',

  // --------------------------------------------------------------------
  // ConfigSwitchCard
  // --------------------------------------------------------------------
  'configSwitch.aria': 'OpenClash config switching',
  'configSwitch.eyebrow': 'Config switching',
  'configSwitch.unnamed': '(unnamed config)',
  'configSwitch.disable.inProgress': 'Config switch already in progress…',
  'configSwitch.disable.homeDown':
    'Router unreachable — switching cannot proceed.',
  'configSwitch.disable.notConfigured':
    'OpenClash management API is not configured; add LuCI URL and credentials in Settings.',
  'configSwitch.disable.unreachable':
    'OpenClash management API is currently unreachable.',
  'configSwitch.guidance':
    'No config files were read from OpenClash. Check that the management interface URL and credentials are correct.',
  'configSwitch.activeBadge': 'Active',

  // --------------------------------------------------------------------
  // ConfirmDialog (config switch confirmation)
  // --------------------------------------------------------------------
  'confirmDialog.title': 'Confirm OpenClash config switch',
  'confirmDialog.warning':
    'Switching restarts the Clash core and drops every existing connection.',
  'confirmDialog.startLabel': 'Current config:',
  'confirmDialog.targetLabel': 'Target config:',
  'confirmDialog.cancel': 'Cancel',
  'confirmDialog.confirm': 'Confirm switch',
  'confirmDialog.unknown': 'unknown',

  // --------------------------------------------------------------------
  // QuickActionsPanel — banners and chrome (Requirement 4.2)
  // --------------------------------------------------------------------
  'quickActions.aria': 'Quick actions',
  'quickActions.banner.homeDown.headline': 'Home offline',
  'quickActions.banner.homeDown.detail':
    'Router is unreachable — every switch will fail. Check your home network and the router power.',
  'quickActions.banner.managementFailures.headline':
    'Management API failing repeatedly',
  'quickActions.banner.managementFailures.detail':
    'OpenClash management API has failed 5+ times in a row — verify credentials or network.',
  'quickActions.banner.managementUnreachable.headline':
    'Management API unreachable',
  'quickActions.banner.managementUnreachable.detail':
    'OpenClash management API is temporarily unreachable; switching is unavailable.',
  'quickActions.banner.kernelUnreachable.headline': 'Core unreachable',
  'quickActions.banner.kernelUnreachable.detail':
    'OpenClash core is not responding; switching configs may help recover.',
  'quickActions.banner.credsError.headline': 'Credential error',
  'quickActions.banner.networkDegraded.headline': 'Network degraded',
  'quickActions.banner.networkDegraded.detail':
    'Current node is degraded; consider switching nodes or configs.',
  'quickActions.banner.ariaTemplate': '{headline}: {detail}',
  'quickActions.lastConfigSwitchPrefix': 'Last config switch:',
  'quickActions.switchUnknownError':
    'Unknown error while switching the configuration.',

  // --------------------------------------------------------------------
  // Management error labels (renderer/lib/format.ts)
  // --------------------------------------------------------------------
  'management.error.auth': 'OpenClash credentials are missing or incorrect.',
  'management.error.http': 'OpenClash management API returned an error.',
  'management.error.network': 'Cannot reach the OpenClash management API.',
  'management.error.verifyTimeout': 'Config switch verification timed out.',
  'management.error.verifyMismatch': 'Config switch verification failed.',
  'management.error.notSupported':
    'This deployment does not support that operation.',
  'management.error.switchInProgress': 'Another switch is already in progress.',

  // --------------------------------------------------------------------
  // Compact widget — WidgetShell chrome (Requirement 4.2)
  // --------------------------------------------------------------------
  'compact.network.aria': 'Network status',
  'compact.usage.aria': 'AI usage',
  'compact.shrink.title': 'Switch to minimal mode',
  'compact.shrink.aria': 'Switch to minimal mode',
  'compact.unselectedReal.primary': 'No real node selected',
  'compact.unselectedReal.tooltip':
    '{group} is currently set to DIRECT/GLOBAL/REJECT.',
  'compact.waitingNode.primary': 'Waiting for node data',
  'compact.waitingNode.tooltip': 'No data for the current node yet.',

  // --------------------------------------------------------------------
  // CompactMiniRail — quota tooltip / aria
  // --------------------------------------------------------------------
  'compactMiniRail.quotaUnknown': '{label} · quota unknown',
  'compactMiniRail.quotaPair.fiveH': '5h {pct}%',
  'compactMiniRail.quotaPair.weekly': 'Weekly {pct}%',
  'compactMiniRail.quotaPair.effective': 'Effective {pct}%',
  'compactMiniRail.quotaSingle': '{label} · {pct}%',

  // --------------------------------------------------------------------
  // StatusHero (Requirement 6.2)
  // --------------------------------------------------------------------
  'statusHero.failsBadge': '{count} failed',

  // --------------------------------------------------------------------
  // QuotaStrip / UsagePanel — time-range labels (Requirement 4.2)
  // --------------------------------------------------------------------
  'usage.range.today': 'Today',
  'usage.range.week': 'This week',
  'usage.range.month': 'This month',

  // --------------------------------------------------------------------
  // Quota window names (Requirement 4.2)
  // --------------------------------------------------------------------
  'quota.window.fiveH': '5-hour quota',
  'quota.window.daily': 'Daily quota',
  'quota.window.weekly': 'Weekly quota',
  'quota.window.monthly': 'Monthly quota',
  'quota.window.rollingUsage': 'Rolling usage',
  'quota.window.weeklyUsage': 'Weekly usage',
  'quota.window.monthlyUsage': 'Monthly usage',
  'quota.window.monthlyAllowance': 'Monthly allowance',
  'quota.window.creditsFallback': 'Credits',

  // Short forms used in the compact rail.
  'quota.window.short.fiveH': '5h',
  'quota.window.short.weekly': 'Weekly',
  'quota.window.short.monthly': 'Monthly',
  'quota.window.short.daily': 'Daily',

  // --------------------------------------------------------------------
  // QuotaSnapshot status badges (Requirement 4.2)
  // --------------------------------------------------------------------
  'quota.snapshot.authExpired': 'Credentials expired',
  'quota.snapshot.upstreamRefused': 'Upstream refused',
  'quota.snapshot.rateLimited': 'Rate limited',
  'quota.snapshot.useLastResult': 'Using last result',
  'quota.snapshot.unavailable': 'Unavailable',
  'quota.snapshot.unsupported': 'Not supported',
  'quota.snapshot.normal': 'Healthy',

  // --------------------------------------------------------------------
  // QuotaSnapshot.source labels (Requirement 4.2)
  // --------------------------------------------------------------------
  'quota.source.importedAuth': 'Auth file',
  'quota.source.remoteApi': 'Official API',
  'quota.source.localLog': 'Local log',
  'quota.source.healthCheck': 'Health check',
  'quota.source.manualApiKey': 'Manual API key',

  // --------------------------------------------------------------------
  // Plan-label prefixes used by UsagePanel
  // --------------------------------------------------------------------
  'usage.plan.tier': 'Tier',
  'usage.plan.package': 'Plan',

  'usage.identityPrefix.project': 'Project {value}',
  'usage.identityPrefix.account': 'Account {value}',

  // --------------------------------------------------------------------
  // QuotaStrip — credits summary
  // --------------------------------------------------------------------
  'quota.credits.balanceLabel': 'Balance',
  'quota.credits.totalPrefix': 'Total {value}',
  'quota.credits.cashPrefix': 'Cash {value}',
  'quota.credits.grantedPrefix': 'Granted {value}',
  'quota.credits.toppedUpPrefix': 'Top-up {value}',
  'quota.credits.sparklineAria': 'Daily usage over the last 14 days',

  // --------------------------------------------------------------------
  // UsagePanel — chart kind labels (Requirement 4.2)
  // --------------------------------------------------------------------
  'usage.kind.output': 'Output',
  'usage.kind.input': 'Input',
  'usage.kind.cache': 'Cache',
  'usage.kind.legendAria':
    'Bar shading from darker to lighter: Output / Input / Cache',

  // --------------------------------------------------------------------
  // UsagePanel — empty-state sentences (Requirement 4.2)
  // --------------------------------------------------------------------
  'usage.empty.allRanges': 'No data available for any range',
  'usage.empty.hoverHint': 'Hover or focus a bar to see detailed values',
  'usage.empty.todayPlaceholder':
    'Hourly usage for today will appear here once activity is recorded.',
  'usage.empty.rangePlaceholder':
    'Daily usage for this range will appear here once activity is recorded.',

  // --------------------------------------------------------------------
  // UsagePanel — chrome / loading / error
  // --------------------------------------------------------------------
  'usage.panel.aria': 'AI usage panel',
  'usage.panel.title': 'Token consumption',
  'usage.panel.rangeAria': 'Time range',
  'usage.panel.loading': 'Loading…',
  'usage.chart.localToken': 'Local Token Usage',
  'usage.chart.apiUsage': 'API Usage Detail',
  'usage.overview.title': 'Quota status',
  'usage.overview.accountSuffix': '{count} accounts',
  'usage.account.typeAuth': 'Auth file',
  'usage.account.typeApiKey': 'Manual API key',

  // --------------------------------------------------------------------
  // UsageBarChart / UsagePanel i18n fixes
  // --------------------------------------------------------------------
  'usage.chart.metricCost': 'API Cost',
  'usage.chart.metricTokens': 'Token Consumption',
  'usage.chart.emptyCost': 'No API cost data available',
  'usage.chart.emptyTokens': 'No token usage data available',
  'usage.chart.estimatedValue': 'Est. {value}',
  'usage.chart.ariaLabel': '{metricName} · {scale} · Peak {peak}',
  'usage.chart.granularityHourScale': 'Hourly',
  'usage.chart.granularityDayScale': 'Daily',
  'usage.chart.perHour': 'PER HOUR',
  'usage.chart.perDay': 'PER DAY',
  'usage.chart.periodCount': '{columnCount} periods',
  'usage.chart.peak': 'Peak',
  'usage.chart.rangeTotal': 'Range Total',
  'usage.chart.colAriaCost': '{time}: {value}',
  'usage.chart.colAriaTokens': '{time}: {value} tokens',
  'usage.chart.colAriaEventsSuffix': ', {count} requests',
  'usage.chart.requestSeries': 'Requests',
  'usage.chart.eventCount': '{count} requests',

  'usage.card.ariaQuota': '{provider} {identity} Quota',
  'usage.card.noQuotaData': 'No quota data available',
  'usage.window.ariaRemaining': '{name}: {remaining} remaining',
  'usage.window.resetSuffix': ' · resets at {time}',

  'usage.notice.deepseekUserTokenRequired': 'DeepSeek API key can only fetch balance; daily usage details require configuring userToken',
  'usage.notice.xiaomiDailyUnavailable': 'Xiaomi MiMo did not return daily API usage details; balance is still displayed correctly',


  // --------------------------------------------------------------------
  // ProviderAuthList — capability and error labels
  // --------------------------------------------------------------------
  'providerAuth.capability.official': 'Official quota',
  'providerAuth.capability.healthOnly': 'Health check only',
  'providerAuth.capability.usageOnly': 'Local usage',
  'providerAuth.capability.unsupported': 'Not supported',

  'providerAuth.error.authMissing': 'Credentials missing',
  'providerAuth.error.authExpired': 'Credentials expired',
  'providerAuth.error.projectMissing': 'Project ID missing',
  'providerAuth.error.upstreamUnauthorized': 'Upstream rejected the credentials',
  'providerAuth.error.rateLimited': 'Upstream rate-limited the request',
  'providerAuth.error.upstreamChanged': 'Upstream API has changed',
  'providerAuth.error.networkError': 'Network error',
  'providerAuth.error.unsupported': 'Not yet implemented (ships in v1.1)',
  'providerAuth.error.parseError': 'Could not parse the auth file',
  'providerAuth.error.unsupportedFile': 'Unsupported file type',
};
