export function quotaWindowDisplayName(name: string, provider = ''): string | null {
  const normalised = normaliseProviderWindowName(name, provider);
  if (normalised !== undefined) return normalised;

  if (name.startsWith('code_review:')) {
    const inner = quotaWindowDisplayName(name.slice('code_review:'.length), provider);
    return inner === null ? null : `Code Review · ${inner}`;
  }
  if (name.startsWith('credits:')) {
    return name.slice('credits:'.length) || '额度积分';
  }

  switch (name) {
    case '5h': return '5 小时限额';
    case 'weekly': return '周限额';
    case 'monthly': return '月限额';
    case 'daily': return '日限额';
    default: return name;
  }
}

export function quotaWindowCompactLabel(name: string, provider = ''): string | null {
  const displayName = quotaWindowDisplayName(name, provider);
  if (displayName === null) return null;

  switch (displayName) {
    case '5 小时限额': return '5h';
    case '周限额': return '周';
    case '月限额': return '月';
    case '日限额': return '日';
    case 'Claude/GPT': return 'GPT';
    case 'Gemini 3.1 Pro Series': return '3.1 Pro';
    case 'Gemini Pro Series': return 'Pro';
    case 'Gemini Flash Lite Series':
    case 'Gemini 2.5 Flash Lite': return 'Lite';
    case 'Gemini Flash Series':
    case 'Gemini 2.5 Flash': return 'Flash';
    case 'Gemini 3 Flash': return '3 Flash';
    case 'Gemini 3.1 Flash Image': return 'Image';
    case 'gemini-3.1-flash-lite': return '3.1 Lite';
    case 'gemini-3.1-flash-lite-preview': return '3.1 Lite P';
    default: return displayName;
  }
}

export function quotaWindowPriority(name: string, provider = ''): number {
  const displayName = quotaWindowDisplayName(name, provider);
  if (displayName === null) return 999;

  switch (displayName) {
    case '5 小时限额': return 0;
    case '日限额': return 1;
    case '周限额': return 2;
    case '月限额': return 3;
  }

  const antigravityOrder = [
    'Claude/GPT',
    'Gemini 3.1 Pro Series',
    'Gemini 2.5 Flash',
    'Gemini 2.5 Flash Lite',
    'Gemini 3 Flash',
    'Gemini 3.1 Flash Image',
  ];
  const geminiCliOrder = [
    'Gemini Flash Lite Series',
    'Gemini Flash Series',
    'Gemini Pro Series',
    'gemini-3.1-flash-lite',
    'gemini-3.1-flash-lite-preview',
  ];
  const order = provider === 'antigravity' ? antigravityOrder : geminiCliOrder;
  const index = order.indexOf(displayName);
  return index === -1 ? 100 : index;
}

function normaliseProviderWindowName(name: string, provider: string): string | null | undefined {
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;
  const base = trimmed.split(':')[0]?.trim() ?? trimmed;
  const upper = base.toUpperCase();
  const lower = base.toLowerCase();

  if (/^MODEL_PLACEHOLDER_M\d+$/.test(upper)) return null;
  if (/^MODEL_CHAT_\d+$/.test(upper)) return normaliseKnownChatModel(upper);
  if (/^MODEL_[A-Z0-9_]+$/.test(upper)) return normaliseEnumModel(upper, provider);
  if (/^response:\d+$/.test(trimmed) || /^\d+$/.test(trimmed)) return null;

  if (lower.includes('gemini-2.5-flash-lite')) {
    return provider === 'antigravity' ? 'Gemini 2.5 Flash Lite' : 'Gemini Flash Lite Series';
  }
  if (lower.includes('gemini-2.5-flash')) {
    return provider === 'antigravity' ? 'Gemini 2.5 Flash' : 'Gemini Flash Series';
  }
  if (lower.includes('gemini-2.5-pro')) {
    return provider === 'antigravity' ? 'Gemini 3.1 Pro Series' : 'Gemini Pro Series';
  }
  if (lower.includes('gemini-3.1-flash-lite-preview')) return 'gemini-3.1-flash-lite-preview';
  if (lower.includes('gemini-3.1-flash-lite')) return 'gemini-3.1-flash-lite';
  if (lower.includes('gemini-3.1-pro')) return 'Gemini 3.1 Pro Series';
  if (lower.includes('gemini-3-flash')) return 'Gemini 3 Flash';

  return undefined;
}

function normaliseKnownChatModel(name: string): string | null {
  switch (name) {
    case 'MODEL_CHAT_20706': return 'Gemini 3 Flash';
    case 'MODEL_CHAT_23310': return 'Gemini 3.1 Flash Image';
    default: return null;
  }
}

function normaliseEnumModel(name: string, provider: string): string | null {
  if (
    name.includes('OPENAI') ||
    name.includes('GPT') ||
    name.includes('ANTHROPIC') ||
    name.includes('CLAUDE')
  ) {
    return 'Claude/GPT';
  }
  if (name.includes('GOOGLE_GEMINI_3_1_FLASH_IMAGE')) return 'Gemini 3.1 Flash Image';
  if (name.includes('GOOGLE_GEMINI_3_1_PRO')) return 'Gemini 3.1 Pro Series';
  if (name.includes('GOOGLE_GEMINI_3_FLASH')) return 'Gemini 3 Flash';
  if (name.includes('GOOGLE_GEMINI_2_5_FLASH_LITE')) {
    return provider === 'antigravity' ? 'Gemini 2.5 Flash Lite' : 'Gemini Flash Lite Series';
  }
  if (name.includes('GOOGLE_GEMINI_2_5_FLASH')) {
    return provider === 'antigravity' ? 'Gemini 2.5 Flash' : 'Gemini Flash Series';
  }
  if (name.includes('GOOGLE_GEMINI_2_5_PRO')) {
    return provider === 'antigravity' ? 'Gemini 3.1 Pro Series' : 'Gemini Pro Series';
  }
  return null;
}
