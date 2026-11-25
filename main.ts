// Steady Scalp — a low-variance momentum scalper for the pump.fun Sharpe Sprint.
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and the
// SDK shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte.

import { runBot } from './vendor/makefun-bot.ts';
import { createScalpBot, DEFAULT_SCALP } from './strategy.ts';

await runBot(createScalpBot(DEFAULT_SCALP));
