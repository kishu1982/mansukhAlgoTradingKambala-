import * as fs from 'fs';
import * as path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data', 'tickbytickData');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

type TickPoint = {
  price: number;
  time: number;
  timeIST: string;
};

type StoredTickData = {
  token: string;
  symbol: string;
  side: 'BUY' | 'SELL';

  reference: {
    price: number;
    updatedAtIST: string;
  };

  lastImprovementTime: number;
  ticks: TickPoint[];
};

function getFilePath(token: string, symbol: string) {
  return path.join(DATA_DIR, `${token}_${symbol}.json`);
}

// ===============================
// MAIN FUNCTION
// ===============================
export async function processTimeBasedExit({
  tick,
  netPosition,
  instrument,
  exitAfterMinutes,
  closePositionFn,
}: {
  tick: { tk: string; lp: number };
  netPosition: any;
  instrument: any;
  exitAfterMinutes: number;
  closePositionFn: (side: 'BUY' | 'SELL', qty: number) => Promise<void>;
}) {
  const token = tick.tk;
  const symbol = instrument.tradingSymbol;
  const ltp = tick.lp;

  const netQty = Number(netPosition.netqty);

  // 🔒 no open position → cleanup
  if (netQty === 0) {
    cleanup(token, symbol);
    return;
  }

  console.log(
    `⏱ TimeExit | ${symbol} | NetQty=${netQty} | LTP=${ltp} | Window=${exitAfterMinutes}m`,
  );

  const side: 'BUY' | 'SELL' = netQty > 0 ? 'BUY' : 'SELL';
  const filePath = getFilePath(token, symbol);

  let data: StoredTickData;
  const now = Date.now();
  const nowIST = getISTString(now);
  const windowMs = exitAfterMinutes * 60 * 1000;

  // ===============================
  // INIT FILE
  // ===============================
  if (!fs.existsSync(filePath)) {
    data = {
      token,
      symbol,
      side,
      reference: {
        price: ltp,
        updatedAtIST: nowIST,
      },
      lastImprovementTime: now,
      ticks: [
        {
          price: ltp,
          time: now,
          timeIST: nowIST,
        },
      ],
    };

    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    console.log('📝 Tick tracking started:', token, symbol);
    return;
  }

  data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

  // ===============================
  // APPEND TICK
  // ===============================
  data.ticks.push({
    price: ltp,
    time: now,
    timeIST: nowIST,
  });

  // trim ticks (memory-safe, audit-safe)
  data.ticks = data.ticks.filter((t) => now - t.time <= windowMs);

  // ===============================
  // CHECK NEW HIGH / LOW
  // ===============================
  const improved =
    side === 'BUY' ? ltp > data.reference.price : ltp < data.reference.price;

  if (improved) {
    data.reference.price = ltp;
    data.reference.updatedAtIST = nowIST;
    data.lastImprovementTime = now;

    console.log(
      `📈 ${symbol} | New ${side === 'BUY' ? 'HIGH' : 'LOW'} ${ltp} @ ${nowIST}`,
    );

    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return;
  }

  // ===============================
  // ⏱ TIME-BASED EXIT (FIXED)
  // ===============================
  const elapsedSinceImprovement = now - data.lastImprovementTime;

  if (elapsedSinceImprovement >= windowMs) {
    console.log(
      `🛑 TIME EXIT | ${symbol} | ${side} | No new ${
        side === 'BUY' ? 'HIGH' : 'LOW'
      } since ${data.reference.updatedAtIST}`,
    );

    await closePositionFn(side, Math.abs(netQty));
    cleanup(token, symbol);
    return;
  }

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ===============================
// CLEANUP
// ===============================
function cleanup(token: string, symbol: string) {
  const filePath = getFilePath(token, symbol);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    console.log('🧹 Cleaned tick file:', token, symbol);
  }
}

// ===============================
// IST TIME HELPER
// ===============================
function getISTString(ts: number = Date.now()) {
  return new Date(ts).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour12: false,
  });
}
