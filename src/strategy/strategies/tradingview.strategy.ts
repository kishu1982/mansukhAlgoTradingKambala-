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
        `📊 Net Position → ${position.symname} | Qty=${position.netqty}`,
      );

      return position;
    } catch (err) {
      this.logger.error('❌ getNetPositions failed', err?.message || err);
      return null;
    }
  }

  private normalizeNetQty(position: any | null): number {
    const qty = position ? Number(position.netqty) : 0;

    if (Number.isNaN(qty)) {
      this.logger.error(`❌ Invalid netqty received: ${position?.netqty}`);
      return 0;
    }

    return qty;
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
      product_type: 'C',
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

  private async closeOppositePositionIfAny(
    netQty: number,
    payloadSide: 'BUY' | 'SELL',
    tradingSymbol: string,
    payload: TradingViewWebhookDto,
  ): Promise<void> {
    if (netQty === 0) return;

    const positionSide = netQty > 0 ? 'BUY' : 'SELL';

    // Same direction → nothing to close
    if (positionSide === payloadSide) {
      this.logger.log('ℹ️ Existing position is same side. No close required.');
      return;
    }

    const closeQty = Math.abs(netQty);
    const closeSide = positionSide === 'BUY' ? 'SELL' : 'BUY';

    this.logger.log(
      `🔁 Closing opposite position | Side=${closeSide} | Qty=${closeQty}`,
    );

    await this.placeMarketOrder(
      closeSide,
      closeQty,
      payload,
      tradingSymbol,
      'AUTO CLOSE OPPOSITE POSITION',
    );
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
      // 2️⃣ POSITION CHECK (ALWAYS)
      // -------------------------------
      const position = await this.getNetPositionByToken(payload.token);
      const netQty = this.normalizeNetQty(position);

      this.logger.log(
        `🧠 Position Gate → token=${payload.token}, netQty=${netQty}`,
      );

      // -------------------------------
      // 3️⃣ CLOSE OPPOSITE POSITION
      // -------------------------------

      await this.closeOppositePositionIfAny(
        netQty,
        payload.side,
        tradingSymbol,
        payload,
      );

      // 🔄 Re-fetch position after close (VERY IMPORTANT)
      const updatedPosition = await this.getNetPositionByToken(payload.token);
      const updatedNetQty = this.normalizeNetQty(updatedPosition);

      this.logger.log(`🔄 Post-close position check → netQty=${updatedNetQty}`);

      // -------------------------------
      // 4️⃣ ENTRY LOGIC
      // -------------------------------
      if (updatedNetQty === 0) {
        this.logger.log(`🚀 Fresh ${payload.side} entry allowed`);

        await this.placeMarketOrder(
          payload.side,
          this.tradeVolume,
          payload,
          tradingSymbol,
          'TV ENTRY',
        );
      } else {
        this.logger.log(
          '⛔ Position still exists after close attempt. Entry skipped.',
        );
      }

      this.logger.log('✅ Strategy execution completed');
    } catch (err) {
      this.logger.error('🔥 Strategy execution failed', err?.message || err);
    }
  }
}

/* 
// old working code
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { TradingViewWebhookDto } from '../dto/tradingview-webhook.dto';
import { MarketService } from './../../market/market.service';
import { OrdersService } from 'src/orders/orders.service';
//import { StrategyResult } from '../interfaces/strategy-result.interface';

@Injectable() // 🔴 REQUIRED
export class TradingViewStrategy {
  private readonly logger = new Logger(TradingViewStrategy.name);
  private tradeVolume = 1;

  constructor(
    private readonly marketService: MarketService,
    private readonly orderService: OrdersService,
  ) {}

  // making functions
  // tradingview.strategy.ts

  private async getNetPositionByToken(token: string): Promise<any | null> {
    const netPositions = await this.orderService
      .getNetPositions()
      .catch((err) => {
        const safeMessage =
          typeof err === 'string'
            ? err
            : err?.message || 'Net position fetch failed';

        this.logger.error('❌ getNetPositions failed', safeMessage);
        return null; // ⛔ do not crash strategy
      });

    if (!netPositions?.data || !Array.isArray(netPositions.data)) {
      this.logger.warn(
        '⚠️ Net positions unavailable or empty, skipping trade logic',
      );
      return null;
    }

    const position = netPositions.data.find((p) => p.token === token) || null;

    if (!position) {
      this.logger.log(`ℹ️ No open position found for token ${token}`);
      return null;
    }

    this.logger.log(
      `📊 Net Position → ${position.symname} (${position.token}) | Qty: ${position.netqty} | Avg: ${position.netavgprc}`,
    );

    return position;
  }

  // main algo function execution

  async execute(payload: TradingViewWebhookDto): Promise<void> {
    this.logger.log(
      `📩 TradingView Signal Received: ${JSON.stringify(payload)}`,
    );

    try {
      // ===============================
      // 1️⃣ Get Security Info
      // ===============================
      const securityInfo = await this.marketService
        .getSecurityInfo({
          exchange: payload.exchange,
          token: payload.token,
        })
        .catch((err) => {
          this.logger.error('❌ getSecurityInfo failed', err?.message || err);
          return null; // ⛔ do not stop strategy
        });

      if (!securityInfo) {
        this.logger.warn(
          `⚠️ Security not found: ${payload.exchange}:${payload.token}`,
        );
        return; // stop strategy execution safely
      }

      this.logger.log(
        `✅ Security validated: ${securityInfo.tsym ?? payload.symbol}`,
      );

      // ===============================
      // 2️⃣ Get Latest Quote
      // ===============================
      const quotes = await this.marketService
        .getQuotes({
          exch: payload.exchange,
          token: payload.token,
        })
        .catch((err) => {
          this.logger.error('❌ getQuotes failed', err?.message || err);
          return null;
        });

      if (!quotes) {
        this.logger.warn('⚠️ Quotes not available');
        return;
      }

      // ===============================
      // 🔮 4️⃣ Trading Logic (placeholder)
      // ===============================

      // ===============================
      // 3️⃣ Get Net Positions (SAFE)
      // ===============================
      const position = await this.getNetPositionByToken(payload.token);
      //this.logger.log('positions data finally received : ', position);

      // 🔒 Normalize netQty (ALWAYS)
      const netQty = position ? Number(position.netqty) : 0;
      if (Number.isNaN(netQty)) {
        this.logger.error(`Invalid netqty received: ${position?.netqty}`);
        return;
      }

      this.logger.log(
        `🧠 Position Check → token=${payload.token}, netQty=${netQty}`,
      );

      // ===============================
      // 🎯 POSITION-FIRST TRADING LOGIC
      // ===============================

      if (netQty === 0) {
        // ✅ No position → entry allowed

        if (payload.side === 'BUY') {
          this.logger.log('📈 ENTRY BUY signal received');

          const orderId = await this.orderService.placeOrder({
            buy_or_sell: 'B',
            product_type: 'C',
            exchange: payload.exchange,
            tradingsymbol: securityInfo.tsym,
            quantity: this.tradeVolume,
            price_type: 'MKT',
            price: 0,
            trigger_price: 0,
            discloseqty: 0,
            retention: 'DAY',
            amo: 'NO',
            remarks: `TV BUY | ${payload.strategy}`,
          });

          this.logger.log(`✅ BUY order placed: ${orderId}`);
          return;
        }

        if (payload.side === 'SELL') {
          this.logger.log('📉 ENTRY SELL signal received');

          const orderId = await this.orderService.placeOrder({
            buy_or_sell: 'S',
            product_type: 'C',
            exchange: payload.exchange,
            tradingsymbol: securityInfo.tsym,
            quantity: this.tradeVolume,
            price_type: 'MKT',
            price: 0,
            trigger_price: 0,
            discloseqty: 0,
            retention: 'DAY',
            amo: 'NO',
            remarks: `TV SELL | ${payload.strategy}`,
          });

          this.logger.log(`✅ SELL order placed: ${orderId}`);
          return;
        }
      }

      console.log('next step ready');

      this.logger.log('🚀 Strategy execution completed successfully');
    } catch (err) {
      // 🔒 Absolute safety net (should never hit)
      const safeMessage =
        typeof err === 'string'
          ? err
          : err?.message || 'Unknown strategy error';

      this.logger.error(
        '🔥 Strategy execution failed unexpectedly',
        safeMessage,
      );
    }
  }
}
*/
