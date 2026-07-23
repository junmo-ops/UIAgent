export interface ChallengeCliOptions {
  split: 'development' | 'holdout' | 'all';
  repeats: number;
  scenarioIds: string[];
  confirmHoldout: boolean;
  pageUrl: string;
  serviceUrl: string;
  keepBrowser: boolean;
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

export function parseOptions(args: string[]): ChallengeCliOptions {
  const split = valueAfter(args, '--split') ?? 'development';
  if (split !== 'development' && split !== 'holdout' && split !== 'all') {
    throw new Error('--split 只支持 development、holdout 或 all');
  }
  const repeats = Number(valueAfter(args, '--repeat') ?? '1');
  if (!Number.isInteger(repeats) || repeats < 1 || repeats > 5) {
    throw new Error('--repeat 必须是 1 到 5 之间的整数');
  }
  if ((split === 'holdout' || split === 'all') && !args.includes('--confirm-holdout')) {
    throw new Error('运行隐藏集必须显式添加 --confirm-holdout，避免在日常调试中反复针对隐藏题调参');
  }
  return {
    split,
    repeats,
    scenarioIds: (valueAfter(args, '--scenario') ?? '').split(',').map(value => value.trim()).filter(Boolean),
    confirmHoldout: args.includes('--confirm-holdout'),
    pageUrl: valueAfter(args, '--page-url') ?? 'http://127.0.0.1:5173',
    serviceUrl: valueAfter(args, '--service-url') ?? 'http://127.0.0.1:8787',
    keepBrowser: args.includes('--keep-browser')
  };
}
