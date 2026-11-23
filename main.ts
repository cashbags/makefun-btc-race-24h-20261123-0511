// Tidebreak — cbBTC dip-buy mean-reversion bot, btc-race-24h-20261123-0511.
// Design: arm when close sits >=60bps under the 120-bar high; buy 100% of
// cash on a confirmed recovery (higher close + reclaim of EMA12), sized
// against close depth (cap 20% of c_depth). Exit on hard stop -150bps,
// stage-1 floor +30bps once +80bps, stage-2 trail -40bps off the peak once
// +120bps, take-profit +150bps, or a 720-bar time cap. 30-bar cooldown
// after exits; after 2 straight losing trades entries halt for the window.
// All money in integer micro-USDC (BigInt); EMAs float64, seeded as the
// mean of the first span of closes. No clock, no randomness, no network,
// no files: two runs on the same bars answer byte-identical orders.
const SYM = "CBBTC";
let warm = 0, n = 0, bi = -1;
let pcash = 1000000000n;
const closes: number[] = [];
let e12 = NaN, e48 = NaN;
let armed = false, dipBar = -1, coolUntil = -1, halted = false, losses = 0;
let pendB: any = null, pendS: any = null;
let entClose = 0, entBar = -1, entNot = 0n, entCost = 0n, peak = 0;

function onLine(line: string): void {
  const m = JSON.parse(line);
  if (m.type === "hello") { warm = m.warmup_bars || 0; return; }
  if (m.type === "done") { process.exit(0); return; }
  if (m.type !== "batch") return;
  const orders: any[] = [];
  const acct = m.account;
  const cashNow = BigInt(acct.cash_quote_units);
  const pos = (acct.positions || []).find((p: any) => p.symbol === SYM);
  const qty = pos ? BigInt(pos.qty) : 0n;
  const cost = pos ? BigInt(pos.cost_quote_units) : 0n;
  for (const f of m.fills || []) {
    if (pendB && f.client_id === pendB.id) {
      if (f.status === "filled") {
        entClose = pendB.close; entBar = pendB.bar; entNot = pendB.not;
        entCost = cost; peak = entClose; armed = false;
      }
      pendB = null;
    } else if (pendS && f.client_id === pendS.id) {
      if (f.status === "filled") {
        const pnl = cashNow - pcash - entNot;
        losses = pnl <= 0n ? losses + 1 : 0;
        if (losses >= 2) halted = true;
        coolUntil = pendS.bar + 30;
        entClose = 0; entBar = -1; entNot = 0n; entCost = 0n; peak = 0;
      }
      pendS = null;
    }
  }
  const bar = (m.bars || []).find((b: any) => b.symbol === SYM);
  if (bar) {
    const c = Number(bar.c);
    closes.push(c);
    bi = closes.length - 1;
    const L = closes.length;
    if (L === 12) e12 = closes.reduce((a, b) => a + b, 0) / 12;
    else if (L > 12) e12 += (2 / 13) * (c - e12);
    if (L === 48) e48 = closes.reduce((a, b) => a + b, 0) / 48;
    else if (L > 48) e48 += (2 / 49) * (c - e48);
    if (m.seq >= warm && !isNaN(e12) && !isNaN(e48)) {
      if (qty === 0n) {
        if (!pendB && !halted && bi <= 1409 && bi >= coolUntil) {
          let hi = 0;
          for (let j = Math.max(0, bi - 119); j <= bi; j++) if (closes[j] > hi) hi = closes[j];
          if (!armed) {
            if (Math.floor((hi - c) * 10000 / hi) >= 60) { armed = true; dipBar = bi; }
          } else if (bi - dipBar > 60) armed = false;
          else if (c > closes[bi - 1] && c >= e12) {
            const cap = BigInt(bar.c_depth[0]) * 2000n / 10000n;
            const not = cashNow < cap ? cashNow : cap;
            if (not >= 1000000n) {
              n++;
              const id = "o" + n;
              pendB = { id, not, close: c, bar: bi };
              orders.push({ side: "buy", client_id: id, symbol: SYM, notional_quote_units: not.toString(), max_slippage_bps: 100 });
            }
          }
        }
      } else if (!pendS && entBar >= 0 && entCost > 0n) {
        if (c > peak) peak = c;
        const val = qty * BigInt(bar.c) / 10000000n;
        const gain = (val - entCost) * 10000n / entCost;
        const pval = qty * BigInt(peak) / 10000000n;
        const pgain = (pval - entCost) * 10000n / entCost;
        let trail = -1;
        if (pgain >= 120n) trail = Math.floor(peak * 9960 / 10000);
        else if (gain >= 80n) trail = Math.floor(entClose * 10030 / 10000);
        const stop = Math.floor(entClose * 9850 / 10000);
        if (c <= stop || (trail >= 0 && c <= trail) || gain >= 150n || bi - entBar >= 720) {
          n++;
          const id = "o" + n;
          pendS = { id, bar: bi };
          orders.push({ side: "sell", client_id: id, symbol: SYM, qty: qty.toString(), max_slippage_bps: 100 });
        }
      }
    }
  }
  pcash = cashNow;
  process.stdout.write(JSON.stringify({ type: "reply", seq: m.seq, orders }) + "\n");
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d: string) => {
  buf += d;
  let i: number;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line) onLine(line);
  }
});
process.stdin.on("end", () => process.exit(0));
