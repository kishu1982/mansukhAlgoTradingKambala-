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
  // 🔹 NET POSITION HELPERS
  // =====================================================

  private async getNetPositionByToken(token: string): Promise<any | null> {
    try {
      const netPositions = await this.orderService.getNetPositions();

      if (!netPositions?.data || !Array.isArray(netPositions.data)) {
        this.logger.warn('⚠️ Net positions unavailable or empty');
        return null;
      }

      const position = netPositions.data.find((p) => p.token === token) || null;

      if (!position) {
        this.logger.log(`ℹ️ No open position for token ${token}`);
        return null;
      }

      this.logger.log(
        `📊 Net Position → ${position.symname} | netQty=${position.netqty}`,
      );

      return position;
    } catch (err) {
      this.logger.error('❌ getNetPositions failed', err?.message || err);
      return null;
    }
  }

  private normalizeNetQty(position: any | null): number {
    if (!position) return 0;

    const qty = Number(position.netqty);

    if (Number.isNaN(qty)) {
      this.logger.error(`❌ Invalid netqty received: ${position.netqty}`);
      return 0;
    }

    return qty;
  }

  // =====================================================
  // 🔹 Add a helper to resolve trade quantity
  // =====================================================
  private resolveTradeQuantity(payload: TradingViewWebhookDto): number {
    const vol = Number(payload.volume);

    if (payload.volume !== undefined && Number.isFinite(vol) && vol > 0) {
      this.logger.log(`📦 Using webhook volume: ${vol}`);
      return Math.floor(vol);
    }

    this.logger.log(`📦 Using default tradeVolume: ${this.tradeVolume}`);
    return this.tradeVolume;
  }

  // =====================================================
  // 🔹 ORDER HELPERS
  // =====================================================

  private async placeMarketOrder(
    side: 'BUY' | 'SELL',
    quantity: number,
    payload: TradingViewWebhookDto,
    tradingSymbol: string,
    reason: string,
  ): Promise<void> {
    if (quantity <= 0) {
      this.logger.warn(`⚠️ Invalid quantity ${quantity}, skipping order`);
      return;
    }

    const buyOrSell = side === 'BUY' ? 'B' : 'S';

    const orderId = await this.orderService.placeOrder({
      buy_or_sell: buyOrSell,
      //product_type: 'C', // delivery
      product_type: 'I', // intraday
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

    this.logger.log(
      `✅ ${side} order placed | Qty=${quantity} | OrderId=${orderId}`,
    );
  }

  // =====================================================
  // 🔹 WAIT & CONFIRM POSITION CLOSE
  // =====================================================

  private async waitForPositionToClose(
    token: string,
    retries = 3,
    delayMs = 1000,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      await this.sleep(delayMs);

      const position = await this.getNetPositionByToken(token);
      const netQty = this.normalizeNetQty(position);

      this.logger.log(`⏳ Recheck ${attempt}/${retries} → netQty=${netQty}`);

      if (netQty === 0) {
        return true;
      }
    }

    return false;
  }

  // =====================================================
  // 🔹 CLOSE OPPOSITE POSITION (FULL QTY)
  // =====================================================

  private async closeOppositePositionIfAny(
    netQty: number,
    payloadSide: 'BUY' | 'SELL',
    tradingSymbol: string,
    payload: TradingViewWebhookDto,
  ): Promise<boolean> {
    if (netQty === 0) return true;

    const positionSide: 'BUY' | 'SELL' = netQty > 0 ? 'BUY' : 'SELL';

    if (positionSide === payloadSide) {
      this.logger.log('ℹ️ Existing position is same side. No close required.');
      return true;
    }

    const closeQty = Math.abs(netQty);
    const closeSide: 'BUY' | 'SELL' = positionSide === 'BUY' ? 'SELL' : 'BUY';

    this.logger.log(`🔁 Closing opposite position → ${closeSide} ${closeQty}`);

    await this.placeMarketOrder(
      closeSide,
      closeQty,
      payload,
      tradingSymbol,
      'AUTO CLOSE OPPOSITE POSITION',
    );

    const closed = await this.waitForPositionToClose(payload.token);

    if (!closed) {
      this.logger.warn('⚠️ Position not closed after retries, skipping entry');
      return false;
    }

    this.logger.log('✅ Opposite position fully closed');
    return true;
  }

  // =====================================================
  // 🔹 MAIN STRATEGY EXECUTION
  // =====================================================

  async execute(payload: TradingViewWebhookDto): Promise<void> {
    this.logger.log(
      `📩 TradingView Signal Received: ${JSON.stringify(payload)}`,
    );

    try {
      // -------------------------------
      // 1️⃣ SECURITY VALIDATION
      // -------------------------------
      const securityInfo = await this.marketService
        .getSecurityInfo({
          exchange: payload.exchange,
          token: payload.token,
        })
        .catch(() => null);

      if (!securityInfo) {
        this.logger.warn(
          `⚠️ Security not found: ${payload.exchange}:${payload.token}`,
        );
        return;
      }

      const tradingSymbol = securityInfo.tsym;
      this.logger.log(`✅ Security validated: ${tradingSymbol}`);

      // -------------------------------
      // 2️⃣ INITIAL POSITION CHECK
      // -------------------------------
      const position = await this.getNetPositionByToken(payload.token);
      const netQty = this.normalizeNetQty(position);

      this.logger.log(`🧠 Initial Position Gate → netQty=${netQty}`);

      // -------------------------------
      // 3️⃣ CLOSE OPPOSITE POSITION
      // -------------------------------
      const canProceed = await this.closeOppositePositionIfAny(
        netQty,
        payload.side,
        tradingSymbol,
        payload,
      );

      if (!canProceed) return;

      // -------------------------------
      // 4️⃣ FINAL CONFIRMATION
      // -------------------------------
      const finalPosition = await this.getNetPositionByToken(payload.token);
      const finalNetQty = this.normalizeNetQty(finalPosition);

      this.logger.log(`🔐 Final Position Gate → netQty=${finalNetQty}`);

      // -------------------------------
      // 5️⃣ ENTRY
      // -------------------------------
      if (finalNetQty === 0) {
        const entryQty = this.resolveTradeQuantity(payload);

        this.logger.log(
          `🚀 Fresh ${payload.side} entry allowed | Qty=${entryQty}`,
        );

        await this.placeMarketOrder(
          payload.side,
          entryQty,
          payload,
          tradingSymbol,
          'TV ENTRY',
        );
      } else {
        this.logger.log('⛔ Position still exists after close. Entry skipped.');
      }

      this.logger.log('✅ Strategy execution completed');
    } catch (err) {
      this.logger.error('🔥 Strategy execution failed', err?.message || err);
    }
  }
}
