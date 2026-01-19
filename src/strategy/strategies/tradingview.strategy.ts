/*
structure of signal function 
Signal received
   ↓
Fetch security
   ↓
Fetch net position (fresh)
   ↓
Normalize netQty
   ↓
Close opposite position (if any)
  {
  netQty = -3
  ↓
  Close BUY 3 (market)
  ↓
  Re-fetch → netQty = 0
  ↓
  Place BUY 1 (tradeVolume)

  } 
   ↓
If netQty == 0 → place new entry
   ↓
Log & exit

*/
import { Injectable, Logger } from '@nestjs/common';
import { TradingViewWebhookDto } from '../dto/tradingview-webhook.dto';
import { MarketService } from './../../market/market.service';
import { OrdersService } from 'src/orders/orders.service';

@Injectable()
export class TradingViewStrategy {
  private readonly logger = new Logger(TradingViewStrategy.name);
  private readonly tradeVolume = 1;
  // =====================================================
  // 🔹 TRADING TIME CONFIG (IST)
  // =====================================================
  private readonly MARKET_CUTOFF_TIME = '15:25'; // HH:mm (IST)
  private readonly TIME_RESTRICTED_EXCHANGES = new Set([
    'NSE',
    'NFO',
    'BSE',
    'BFO',
  ]);

  constructor(
    private readonly marketService: MarketService,
    private readonly orderService: OrdersService,
  ) {}

  // =====================================================
  // 🔹 UTILS
  // =====================================================
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // =====================================================
  // 🔹 Add IST time helper
  // =====================================================
  private isAfterMarketCutoff(): boolean {
    const now = new Date();

    // Convert to IST
    const istTime = new Date(
      now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }),
    );

    const [cutoffHour, cutoffMinute] =
      this.MARKET_CUTOFF_TIME.split(':').map(Number);

    const cutoff = new Date(istTime);
    cutoff.setHours(cutoffHour, cutoffMinute, 0, 0);

    return istTime >= cutoff;
  }

  // =====================================================
  // 🔹 NET POSITION (AGGREGATED)
  // =====================================================
  private async getAggregatedNetPosition(
    token: string,
    exchange: string,
  ): Promise<{ netQty: number; positions: any[] }> {
    const netPositions = await this.orderService.getNetPositions();

    if (!Array.isArray(netPositions?.data)) {
      this.logger.warn('⚠️ Net positions unavailable');
      return { netQty: 0, positions: [] };
    }

    // 🔥 Aggregate EVERYTHING for same token + exchange
    const matchedPositions = netPositions.data.filter(
      (p) => p.token === token && p.exch === exchange,
    );

    const netQty = matchedPositions.reduce(
      (sum, p) => sum + Number(p.netqty || 0),
      0,
    );

    this.logger.log(
      `📊 Net Position (Aggregated) → ${exchange}:${token} | netQty=${netQty} | rows=${matchedPositions.length}`,
    );

    // Optional detailed debug
    matchedPositions.forEach((p) => {
      this.logger.debug(`   ↳ prd=${p.prd ?? 'NA'} | netqty=${p.netqty}`);
    });

    return { netQty, positions: matchedPositions };
  }

  // =====================================================
  // 🔹 TRADE QTY
  // =====================================================
  private resolveTradeQuantity(payload: TradingViewWebhookDto): number {
    const vol = Number(payload.volume);

    if (Number.isFinite(vol) && vol > 0) {
      this.logger.log(`📦 Using webhook volume: ${vol}`);
      return Math.floor(vol);
    }

    this.logger.log(`📦 Using default tradeVolume: ${this.tradeVolume}`);
    return this.tradeVolume;
  }

  // =====================================================
  // 🔹 FINAL TRADE QTY (QTY × LOT SIZE)
  // =====================================================
  private getFinalTradeQuantity(
    payload: TradingViewWebhookDto,
    lotSize: number,
  ): number {
    const baseQty = this.resolveTradeQuantity(payload);
    const finalQty = baseQty * (Number(lotSize) || 1);

    this.logger.log(
      `🧮 Quantity calc → baseQty=${baseQty}, lotSize=${lotSize}, finalQty=${finalQty}`,
    );

    return finalQty;
  }

  // =====================================================
  // 🔹 ORDER
  // =====================================================
  private async placeMarketOrder(
    side: 'BUY' | 'SELL',
    quantity: number,
    payload: TradingViewWebhookDto,
    tradingSymbol: string,
    reason: string,
  ): Promise<void> {
    if (quantity <= 0) return;

    const orderId = await this.orderService.placeOrder({
      buy_or_sell: side === 'BUY' ? 'B' : 'S',
      product_type: 'I',
      exchange: payload.exchange,
      tradingsymbol: tradingSymbol,
      quantity,
      price_type: 'MKT',
      price: 0,
      trigger_price: 0,
      discloseqty: 0,
      retention: 'DAY',
      amo: 'NO',
      remarks: `${reason} | ${payload.strategy}`,
    });

    this.logger.log(`✅ ${side} placed | Qty=${quantity} | OrderId=${orderId}`);
  }

  // =====================================================
  // 🔹 WAIT FOR FLATTEN
  // =====================================================
  private async waitForPositionToClose(
    token: string,
    exchange: string,
    retries = 3,
    delayMs = 1000,
  ): Promise<void> {
    for (let i = 1; i <= retries; i++) {
      await this.sleep(delayMs);

      const { netQty } = await this.getAggregatedNetPosition(token, exchange);
      this.logger.log(`⏳ Recheck ${i}/${retries} → netQty=${netQty}`);

      if (netQty === 0) return;
    }

    this.logger.warn('⚠️ Position not fully flattened after retries');
  }

  // =====================================================
  // 🔹 CLOSE OPPOSITE
  // =====================================================
  private async closeOppositeIfAny(
    netQty: number,
    payloadSide: 'BUY' | 'SELL',
    tradingSymbol: string,
    payload: TradingViewWebhookDto,
  ): Promise<boolean> {
    if (netQty === 0) return false;

    const currentSide: 'BUY' | 'SELL' = netQty > 0 ? 'BUY' : 'SELL';

    if (currentSide === payloadSide) {
      this.logger.log('ℹ️ Same-side position exists. No close needed.');
      return false;
    }

    const closeQty = Math.abs(netQty);
    const closeSide: 'BUY' | 'SELL' = currentSide === 'BUY' ? 'SELL' : 'BUY';

    this.logger.log(`🔁 Closing ${closeSide} ${closeQty}`);

    await this.placeMarketOrder(
      closeSide,
      closeQty,
      payload,
      tradingSymbol,
      'AUTO CLOSE OPPOSITE',
    );

    await this.waitForPositionToClose(payload.token, payload.exchange);

    return true;
  }

  // =====================================================
  // 🔹 MAIN EXECUTION
  // =====================================================
  async execute(payload: TradingViewWebhookDto): Promise<void> {
    this.logger.log(`📩 Signal → ${JSON.stringify(payload)}`);

    // =====================================================
    // 🔒 MARKET TIME GUARD (IST)
    // =====================================================
    if (
      this.TIME_RESTRICTED_EXCHANGES.has(payload.exchange) &&
      this.isAfterMarketCutoff()
    ) {
      this.logger.warn(
        `⏰ Trading time over for ${payload.exchange}. Cutoff=${this.MARKET_CUTOFF_TIME} IST. No new trades allowed.`,
      );
      return;
    }

    try {
      const security = await this.marketService.getSecurityInfo({
        exchange: payload.exchange,
        token: payload.token,
      });

      if (!security) return;

      const tradingSymbol = security.tsym;
      const lotSize = Number(security.ls) || 1;

      this.logger.log(`📐 Lot size detected → ls=${lotSize}`);

      // 1️⃣ Initial net position
      const { netQty } = await this.getAggregatedNetPosition(
        payload.token,
        payload.exchange,
      );

      this.logger.log(`🧠 Initial netQty=${netQty}`);

      // 2️⃣ Close opposite if required
      const closedOpposite = await this.closeOppositeIfAny(
        netQty,
        payload.side,
        tradingSymbol,
        payload,
      );

      //const entryQty = this.resolveTradeQuantity(payload);
      const entryQty = this.getFinalTradeQuantity(payload, lotSize);

      // 3️⃣ ENTRY LOGIC (GUARANTEED)
      if (closedOpposite) {
        this.logger.log(`🚀 Forced ${payload.side} entry`);

        await this.placeMarketOrder(
          payload.side,
          entryQty,
          payload,
          tradingSymbol,
          'ENTRY AFTER CLOSE',
        );
        return;
      }

      if (netQty === 0) {
        this.logger.log(`🚀 Fresh ${payload.side} entry`);

        await this.placeMarketOrder(
          payload.side,
          entryQty,
          payload,
          tradingSymbol,
          'FRESH ENTRY',
        );
      } else {
        this.logger.log('ℹ️ Position already aligned. No action.');
      }
    } catch (err) {
      this.logger.error('🔥 Strategy failed', err?.message || err);
    }
  }
}
