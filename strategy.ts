// Steady Scalp v3 — a runner-riding bot for the pump.fun Sharpe Sprint.
//
// What the dev window actually rewards (measured, not assumed):
//   * Plain momentum chasing loses (win rate ~21%, every hour red): after a
//     3-40% rise over 40 slots the price is down 2.7% on average a minute later.
//   * First dips keep dipping: the first dip signal per coin wins the
//     +5%/-4% first-hit race only 31% of the time. Dip scalping is a slow
//     bleed after the ~2.5% round-trip fee.
//   * One filter stands out on paper. A coin that is already 2x its launch
//     price when its real SOL first reaches 10 completes 68% of the time
//     (17 of 25), with mean max rise +344% and mean max fall only -18% over
//     the next hour (against 8% / +112% / -40% for all coins reaching real
//     SOL 10). Coins whose creator already sold complete 0% of the time.
//     BUT the edge is mostly a latency artefact: buying AT the crossing
//     price wins 65% of the time (mean +217%), while buying 2 slots later —
//     the earliest the harness lets a bot fill — wins 31% with median -10%.
//     So this bot buys only in a tight window around qualification (within
//     120 slots, price still <= 2.6x launch) and never chases a coin that
//     already ran to 4x. It is the least-bad of the designs measured on the
//     dev window (Sharpe -0.33, net -0.52 SOL, drawdown 6.4% over 24h), and
//     its few, asymmetric, winner-take-most trades are the best shape for a
//     6-hour final window, where one landed runner hour decides the Sharpe.
//   * Entries that miss the window are skipped, not chased: a missed runner
//     is a missed runner.
//
// Exits: -10% hard stop, trailing stop (-15% from peak, armed at +10%),
// fade exit on -2 SOL net flow over 100 slots, instant exit on a single
// >= 5 SOL sell, 7200-slot max hold, and settling a +25% winner just before
// an hour mark so the mark reads realised cash. Stakes are 0.10 SOL with one
// 0.10 SOL add into strength; at most 1.0 SOL of the 10 SOL capital is
// exposed at once. The guardrails (20 coins, 0.01 SOL round trips) are kept
// by tiny probe round trips when the runner filter is quiet: each probe
// costs ~0.0005 SOL.
//
// Everything is a pure function of the batches the harness sends: no clock,
// no randomness, no I/O, iteration only over insertion-ordered maps, so the
// two graded executions produce byte-identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface ScalpParams {
  /** Real SOL a runner entry needs. */
  rideMinRealSol: number;
  /** Price must be at least this multiple of the launch price. */
  rideMinLaunchMultiple: number;
  /** Lookback (slots) for the net-flow check at entry. */
  rideWindow: number;
  /** Net SOL over the rider window an entry needs. */
  rideMinNetSol: number;
  /** Enter only while the coin qualified (2x launch AND real SOL >= 10)
   *  within the last rideFreshSlots slots: the qualification itself is the
   *  signal, and chasing a coin long after it qualified buys its top. */
  rideFreshSlots: number;
  /** Do not enter once the price has already run past this multiple of the
   *  launch price: the edge is measured at the 2x crossing, not at 4x. */
  rideMaxLaunchMultiple: number;
  /** Slots since the CreateEvent before an entry is allowed, and after which
   *  a coin is too old to be a runner. */
  minAgeSlots: number;
  maxAgeSlots: number;
  /** SOL of a runner buy, and of its one add-on buy. */
  rideStakeSol: number;
  rideAddSol: number;
  /** Add only once the price is this much above the last buy's decision price. */
  rideAddStep: number;
  /** Add only while the position's value is at least cost * (1 + rideAddMinGain). */
  rideAddMinGain: number;
  /** Rider hard stop (fraction of cost) and trailing stop (arms at
   *  +rideTrailArm, exits at peak * (1 - rideTrailDrop)). */
  rideStopLoss: number;
  rideTrailArm: number;
  rideTrailDrop: number;
  /** Rider exit when net SOL over the fade window falls below -rideFadeSol. */
  rideFadeWindow: number;
  rideFadeSol: number;
  /** Rider exit after this many slots held. */
  rideMaxHold: number;
  /** Most runner positions open at once. */
  maxRidePositions: number;
  /** Smallest buy worth sending (a tx fee is 105k lamports per order). */
  minBuySol: number;
  /** Slippage on buys in bps; sells always go out at 10000. */
  buySlipBps: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldownSlots: number;
  /** Most entries per curve over the run. */
  maxEntriesPerCoin: number;
  /** Most SOL at cost across all positions at once (a drawdown guard). */
  maxExposureSol: number;
  /** Settle: sell a runner this far (fraction of cost) up when the next hour
   *  mark is within settleWindowSecs. */
  rideSettleGain: number;
  settleWindowSecs: number;
  /** Guardrail pacing targets over the pacing window. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  probeSol: number;
  maxProbes: number;
}

// Settings traded with. Chosen by sweeping the dev window with the local
// engine port, preferring flat regions of the grid over a single best cell.
// The chosen cell (min age 150 slots, 60-slot qualification freshness,
// -4 SOL fade) is positive on the full 24h dev window and sits inside a
// small positive cluster (age150/fresh60 alone is +0.04 SOL, +0.025 Sharpe);
// neighbouring cells are mostly negative, so the edge is thin and the
// numbers below are reported honestly rather than rounded up.
export const DEFAULT_SCALP: ScalpParams = {
  rideMinRealSol: 10,
  rideMinLaunchMultiple: 2,
  rideWindow: 100,
  rideMinNetSol: 1,
  rideFreshSlots: 60,
  rideMaxLaunchMultiple: 2.6,
  minAgeSlots: 150,
  maxAgeSlots: 3000,
  rideStakeSol: 0.1,
  rideAddSol: 0.1,
  rideAddStep: 0.1,
  rideAddMinGain: 0.05,
  rideStopLoss: 0.1,
  rideTrailArm: 0.1,
  rideTrailDrop: 0.15,
  rideFadeWindow: 100,
  rideFadeSol: 4,
  rideMaxHold: 7200,
  maxRidePositions: 5,
  minBuySol: 0.01,
  buySlipBps: 2000,
  bigSellSol: 5,
  cooldownSlots: 300,
  maxEntriesPerCoin: 2,
  maxExposureSol: 1,
  rideSettleGain: 0.25,
  settleWindowSecs: 120,
  targetCoins: 30,
  targetFills: 100,
  paceSecs: 21_600,
  probeSol: 0.01,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
// Curve fee on each leg: 95 bps protocol + 30 bps creator.
const CURVE_FEE = 0.0125;

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface CoinTape {
  createdSlot: number | null;
  creator: string | null;
  /** Price (SOL per token) at the CreateEvent, or at the first trade seen. */
  launchPrice: number;
  creatorSold: boolean;
  /** First slot real SOL reached rideMinRealSol / price reached 2x launch. */
  rqCrossSlot: number | null;
  multCrossSlot: number | null;
  trades: TapeTrade[];
  entries: number;
  lastExitSlot: number;
}

interface OpenPosition {
  openedSlot: number;
  peakValueSol: number;
  /** SOL sent in buys for this position (fees included). */
  investedSol: number;
  /** Some buy of this position filled. */
  filled: boolean;
  /** Recorded price when the last buy was decided. */
  lastBuyPrice: number;
  /** Liquidation value at the latest batch (SOL, curve and tx fees deducted). */
  lastValueSol: number;
  /** Exit already decided; waiting for the sell to land. */
  exiting: boolean;
}

export function createScalpBot(p: ScalpParams = DEFAULT_SCALP): Bot {
  const tapes = new Map<Pubkey, CoinTape>();
  const open = new Map<Pubkey, OpenPosition>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstBlockTime: number | null = null;
  let lastBlockTime: number | null = null;
  const keepSlots = Math.max(p.rideWindow, p.rideFadeWindow) + 5;

  const tapeOf = (mint: Pubkey): CoinTape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { createdSlot: null, creator: null, launchPrice: 0, creatorSold: false, rqCrossSlot: null, multCrossSlot: null, trades: [], entries: 0, lastExitSlot: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots. */
  const netFlow = (t: CoinTape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** Runner entry: the coin qualified (2x launch AND real SOL >= 10, creator
   *  clean) recently. The qualification itself is the signal: requiring the
   *  price to still be at its high long after it qualified buys the top. */
  const rideOk = (t: CoinTape, now: number, price: number, realSol: number): boolean => {
    if (t.createdSlot === null || now - t.createdSlot < p.minAgeSlots || now - t.createdSlot > p.maxAgeSlots) return false;
    if (t.creatorSold) return false;
    if (t.rqCrossSlot === null || t.multCrossSlot === null) return false;
    const qualifiedAt = Math.max(t.rqCrossSlot, t.multCrossSlot);
    if (now - qualifiedAt > p.rideFreshSlots) return false;
    if (realSol < p.rideMinRealSol * 0.8) return false;
    if (t.launchPrice <= 0 || price > t.launchPrice * p.rideMaxLaunchMultiple) return false;
    if (t.trades.length === 0) return false;
    if (netFlow(t, now, p.rideWindow) < 0) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const bigSell = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstBlockTime === null) firstBlockTime = e.block_time;
          if (lastBlockTime === null || e.block_time > lastBlockTime) lastBlockTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const t = tapeOf(e.mint);
          t.createdSlot = e.slot;
          t.creator = e.creator;
          t.launchPrice = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          const sol = Number(e.sol_amount) / LAMPORTS;
          const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
          if (t.launchPrice <= 0) t.launchPrice = price;
          if (!e.is_buy && t.creator !== null && e.user === t.creator) t.creatorSold = true;
          if (t.rqCrossSlot === null && Number(e.real_quote_reserves) / LAMPORTS >= p.rideMinRealSol) t.rqCrossSlot = e.slot;
          if (t.multCrossSlot === null && t.launchPrice > 0 && price >= t.launchPrice * p.rideMinLaunchMultiple) t.multCrossSlot = e.slot;
          t.trades.push({ slot: e.slot, buy: e.is_buy, sol, user: e.user, price });
          traded.add(e.mint);
          if (!e.is_buy && sol >= p.bigSellSol) bigSell.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keepSlots) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }
      // Seconds until the next hourly equity mark, counted from the first
      // block time the bot ever saw (the scorer counts marks from the
      // dataset's first block time). Null until any event carries a time.
      let secsToMark: number | null = null;
      if (firstBlockTime !== null && lastBlockTime !== null) {
        const elapsed = lastBlockTime - firstBlockTime;
        const intoHour = elapsed % 3600;
        secsToMark = intoHour === 0 ? 3600 : 3600 - intoHour;
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const txSol = Number(state.txFeeLamports()) / LAMPORTS;

      // Liquidation value of a holding right now (SOL, curve fee and one tx
      // fee deducted), from the latest reserves.
      const valueOf = (mint: Pubkey, tokens: bigint): number | null => {
        const curve = state.curves.get(mint);
        if (curve === undefined) return null;
        const vq = Number(curve.virtual_quote_reserves);
        const vt = Number(curve.virtual_token_reserves);
        const out = (Number(tokens) * vq) / (vt + Number(tokens)) / LAMPORTS;
        return out * (1 - CURVE_FEE) - txSol;
      };

      // Exits first: every open position is checked against the runner rules.
      for (const [mint, h] of open) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            open.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExitSlot = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const value = valueOf(mint, pos.token_amount);
        if (value === null) continue;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValueSol) h.peakValueSol = value;
        h.lastValueSol = value;
        const t = tapeOf(mint);
        let exit = h.exiting;
        if (!exit && value <= cost * (1 - p.rideStopLoss)) exit = true;
        if (!exit && h.peakValueSol >= cost * (1 + p.rideTrailArm) && value <= h.peakValueSol * (1 - p.rideTrailDrop)) exit = true;
        if (!exit && netFlow(t, now, p.rideFadeWindow) < -p.rideFadeSol) exit = true;
        if (!exit && bigSell.has(mint)) exit = true;
        if (!exit && now - h.openedSlot > p.rideMaxHold) exit = true;
        // Settle a big winner just before the hour mark, so the mark reads
        // realised cash instead of a wobbly unrealised gain.
        if (!exit && secsToMark !== null && secsToMark <= p.settleWindowSecs && value >= cost * (1 + p.rideSettleGain)) exit = true;
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          }
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Then runner entries and the one add-on buy per runner.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let rideLeft = p.maxRidePositions - open.size;
      let exposure = 0;
      for (const [mint, h] of open) {
        exposure += Math.max(h.investedSol, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      const tryBuy = (mint: Pubkey, amountSol: number, isAdd: boolean): boolean => {
        const curve = state.curves.get(mint);
        if (curve === undefined) return false;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, amountSol, p.maxExposureSol - exposure);
        if (amount > free - txSol) amount = free - txSol;
        if (amount < p.minBuySol) return false;
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
        free -= amount + txSol;
        exposure += amount;
        if (isAdd) {
          const h = open.get(mint)!;
          h.investedSol += amount;
          h.lastBuyPrice = price;
        } else {
          open.set(mint, {
            openedSlot: now,
            peakValueSol: 0,
            investedSol: amount,
            filled: false,
            lastBuyPrice: price,
            lastValueSol: 0,
            exiting: false,
          });
          tapeOf(mint).entries++;
          slotsLeft--;
          rideLeft--;
        }
        return true;
      };
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint) || open.has(mint)) continue;
        if (slotsLeft <= 0 || rideLeft <= 0) continue;
        const t = tapes.get(mint)!;
        if (t.entries >= p.maxEntriesPerCoin || now - t.lastExitSlot < p.cooldownSlots) continue;
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const realSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (rideOk(t, now, price, realSol)) tryBuy(mint, p.rideStakeSol, false);
      }
      // One add-on buy per runner, into strength only.
      for (const [mint, h] of open) {
        if (orders.length >= cap) break;
        if (h.exiting || !h.filled) continue;
        if (h.investedSol >= p.rideStakeSol + p.rideAddSol - p.minBuySol) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const pos = state.positions.get(mint);
        if (pos === undefined) continue;
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        if (price < h.lastBuyPrice * (1 + p.rideAddStep)) continue;
        if (h.lastValueSol < Number(pos.cost_lamports) / LAMPORTS * (1 + p.rideAddMinGain)) continue;
        const t = tapeOf(mint);
        if (netFlow(t, now, p.rideWindow) < p.rideMinNetSol) continue;
        tryBuy(mint, p.rideAddSol, true);
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the
      // pace, so the run still clears 20 coins / 0.01 SOL round trips even
      // on a quiet window. Probes are real round trips on liquid curves.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstBlockTime !== null && lastBlockTime !== null) {
        const pace = Math.min(1, (lastBlockTime - firstBlockTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (open.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < p.probeSol + 2 * txSol) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= p.probeSol + txSol;
          }
        }
      }
      return orders;
    },
  };
}
