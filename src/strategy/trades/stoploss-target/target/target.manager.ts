import { OrdersService } from 'src/orders/orders.service';
import { ConfigService } from '@nestjs/config';
import {
  appendTargetTrack,
  readTargetTrack,
  isTradeAlreadyClosed,
  countActionReason,
  canAppendAction,
  getTargetTrackKey,
} from './target.helpers';
import { processTimeBasedExit } from './timeBasedExit.helper';
import { IsNumber, IsString } from 'class-validator';
import { Logger } from '@nestjs/common';

export class TargetManager {
  private readonly TARGET_PERCENT: number;
  private readonly targetLocks = new Set<string>();
  private readonly TARGET_EXIT_PERCENT: number;
  private readonly logger = new Logger(TargetManager.name);

  constructor(
    private readonly ordersService: OrdersService,
    private readonly config: ConfigService,
  ) {
    const raw = this.config.get<string>('TARGET_FIRST_PERCENT', '0.25');
    const value = Number(raw);
    this.TARGET_PERCENT = value > 1 ? value / 100 : value;

    // profit booking part to change percentage
    const rawExit = this.config.get<string>('TARGET_EXIT_PERCENT', '0.5');
    const exitValue = Number(rawExit);
    this.TARGET_EXIT_PERCENT = exitValue > 1 ? exitValue / 100 : exitValue;
  }

  // main fucntion to check and process target bookin g
  async checkAndProcessTarget({
    tick,
    netPosition,
    tradeBook,
    instrument,
    config,
  }: {
    tick: { tk: string; e: string; lp: number };
    netPosition: any;
    tradeBook: any[];
    instrument: any;
    config?: {
      targetFirst: number;
    };
  }) {
    // this.logger.debug(
    //   `Checking target for ${tick.e} ${tick.tk} at LTP ${tick.lp} with net position ${netPosition.netqty}`,
    // );
    const TARGET_PERCENT = config?.targetFirst ?? this.TARGET_PERCENT;

    const token = tick.tk;
    const ltp = tick.lp;

    const netQty = Math.abs(Number(netPosition.netqty));
    if (netQty <= 0) return;
    // this.logger.debug(
    //   `Net quantity is ${netQty}, proceeding with target check...`,
    // );

    const positionSide = Number(netPosition.netqty) > 0 ? 'BUY' : 'SELL';
    const entryTradeSide = positionSide === 'BUY' ? 'B' : 'S';

    const entryTrades = tradeBook
      .filter(
        (t) =>
          t.token === token &&
          t.exch === tick.e &&
          t.trantype === entryTradeSide,
      )
      .sort(
        (a, b) => new Date(b.exch_tm).getTime() - new Date(a.exch_tm).getTime(),
      );

    if (!entryTrades.length) return;
    // this.logger.debug(
    //   `Found ${entryTrades.length} entry trades, latest at ${entryTrades[0].exch_tm}, proceeding with target check...`,
    // );

    const entryTrade = entryTrades[0];
    const entryOrderId = entryTrade.norenordno;
    const entryPrice = Number(entryTrade.flprc);

    if (!entryOrderId) return;

    this.logger.debug(
      `Entry price is ${entryPrice}, calculating target at ${TARGET_PERCENT * 100}%...`,
    );
    // this.logger.debug(
    //   `entryorderid is ${entryOrderId}, token is ${token}, exchange is ${tick.e} checking....`,
    // );

    const trackKey = getTargetTrackKey(token, entryOrderId);
    const track = readTargetTrack(trackKey);

    // ===========================
    // ====
    // 🚀 Time Based Exit
    // ===============================
    await this.handleTimeBasedExit({
      tick,
      netPosition,
      instrument,
      entryOrderId,
    });

    // ===============================
    // 🚫 TRADE CLOSED
    // ===============================
    if (isTradeAlreadyClosed(track)) return;

    // ===============================
    // 🔍 CHECK IF TARGET ALREADY EXECUTED
    // ===============================
    const placedOrder = track.find((t) => t.action === 'TARGET_ORDER_PLACED');

    if (placedOrder?.orderId) {
      const matched = tradeBook.find(
        (t) => t.norenordno === placedOrder.orderId,
      );

      if (matched) {
        appendTargetTrack(trackKey, {
          action: 'TARGET_BOOKED_50_PERCENT',
        });
        return;
      }
    }

    // ===============================
    // 🚫 ALREADY PLACED
    // ===============================
    const alreadyPlaced = track?.some(
      (t) => t.action === 'TARGET_ORDER_PLACED',
    );

    if (alreadyPlaced) return;

    // ===============================
    // 🎯 CALCULATE TARGET
    // ===============================
    const side = positionSide;

    const targetPrice =
      side === 'BUY'
        ? entryPrice * (1 + TARGET_PERCENT)
        : entryPrice * (1 - TARGET_PERCENT);

    if (targetPrice <= 0) return;

    // ===============================
    // 📏 DISTANCE FILTER (IMPORTANT)
    // ===============================
    // const distance = Math.abs(ltp - targetPrice) / ltp;
    // if (distance > 0.05) return;
    const distance = Math.abs(ltp - targetPrice) / ltp;

    // skip ONLY if extremely far (like bad calculation)
    if (distance > 1) {
      this.logger.warn(`❌ Target too far. Skipping. Distance: ${distance}`);
      return;
      //done
    }

    // ===============================
    // 📦 LOT LOGIC
    // ===============================
    const lotSize = Number(instrument.lotSize || instrument.lotsize || 1);

    if (netQty <= lotSize) return;

    const rawCloseQty = netQty * this.TARGET_EXIT_PERCENT;
    const closeQty = Math.floor(rawCloseQty / lotSize) * lotSize;

    // if (closeQty < lotSize) return;
    if (closeQty < lotSize) {
      this.logger.log(
        `Calculated close quantity ${closeQty} is less than lot size ${lotSize}, skipping target booking.============================`,
      );
      return;
    }
    //Validate quantity before placing
    if (closeQty % lotSize !== 0) {
      this.logger.error(`❌ INVALID LOT SIZE QUANTITY: ${closeQty}`);
      return;
    }

    // ===============================
    // 🔁 RETRY LOGIC
    // ===============================
    const retryCount = track.filter(
      (t) => t.action === 'TARGET_ORDER_RETRY',
    ).length;

    if (retryCount >= 3) return;

    const lastRetry = [...track]
      .reverse()
      .find((t) => t.action === 'TARGET_ORDER_RETRY');

    if (lastRetry) {
      const lastTime = new Date(lastRetry.time).getTime();
      if (Date.now() - lastTime < 2000) return;
    }

    // ===============================
    // 🔒 LOCK
    // ===============================
    if (this.targetLocks.has(trackKey)) return;
    this.targetLocks.add(trackKey);

    try {
      const latestTrack = readTargetTrack(trackKey);

      const bookedInsideLock = latestTrack?.some(
        (t) => t.action === 'TARGET_BOOKED_50_PERCENT',
      );
      if (bookedInsideLock) return;

      const alreadyPlacedInsideLock = latestTrack?.some(
        (t) => t.action === 'TARGET_ORDER_PLACED',
      );
      if (alreadyPlacedInsideLock) return;

      // ===============================
      // 💰 PRICE CALCULATION
      // ===============================
      // const roundToTick = (price: number) => Math.round(price * 20) / 20;

      const tickSize = Number(
        instrument.tickSize || instrument.tick_size || 0.05,
      );

      const roundToTick = (price: number) =>
        Math.round(price / tickSize) * tickSize;

      let limitPrice = roundToTick(targetPrice);

      // if (side === 'BUY') {
      //   limitPrice = Math.max(limitPrice, ltp);
      // } else {
      //   limitPrice = Math.min(limitPrice, ltp);
      // }

      // safer pricing for execution
      if (side === 'BUY') {
        limitPrice = roundToTick(ltp + tickSize);
      } else {
        limitPrice = roundToTick(ltp - tickSize);
      }

      // ===============================
      // 🚀 Updating product type dynamicaly
      // ===============================
      let productType = netPosition.prd;

      if (tick.e === 'NFO' || tick.e === 'BFO') {
        if (!['MIS', 'NRML'].includes(productType)) {
          productType = 'NRML';
        }
      }

      if (tick.e === 'NFO' || tick.e === 'BFO') {
        this.logger.warn(`⚠️ F&O ORDER FLOW DETECTED`);
      }

      // ===============================
      // 🚀 PLACE ORDER
      // ===============================
      try {
        this.logger.warn(`
        ========== TARGET DEBUG ==========
        Exchange: ${tick.e}
        Symbol: ${instrument.tradingSymbol}
        Side: ${side}
        PositionSide: ${positionSide}
        EntryPrice: ${entryPrice}
        LTP: ${ltp}
        TargetPrice: ${targetPrice}
        LimitPrice: ${limitPrice}
        LotSize: ${lotSize}
        NetQty: ${netQty}
        CloseQty: ${closeQty}
        ProductType: ${netPosition.prd}
        =================================
        `);

        const res = await this.ordersService.placeOrder({
          buy_or_sell: side === 'BUY' ? 'S' : 'B',
          product_type: netPosition.prd,
          exchange: tick.e,
          tradingsymbol: instrument.tradingSymbol,
          quantity: closeQty,
          price_type: 'LMT',
          price: limitPrice,
          trigger_price: 0,
          retention: 'DAY',
          remarks: 'AUTO_TARGET_PENDING',
        });

        this.logger.log(
          `🎯 Target placed | ${res?.norenordno} | ${instrument.tradingSymbol} | at @ ${limitPrice} | Qty: ${closeQty} for AUTO_TARGET_PENDING limit order`,
        );

        // log full response for debugging
        this.logger.debug(`Order API response: ${JSON.stringify(res)}`);

        const orderId = res?.norenordno;

        if (!orderId) {
          appendTargetTrack(trackKey, {
            action: 'TARGET_ORDER_RETRY',
            reason: 'NO_ORDER_ID',
          });
          return;
        }

        appendTargetTrack(trackKey, {
          action: 'TARGET_ORDER_PLACED',
          entryPrice,
          targetPrice,
          closeQty,
          orderId,
        });
      } catch (err) {
        appendTargetTrack(trackKey, {
          action: 'TARGET_ORDER_RETRY',
          reason: 'ORDER_FAILED',
          retryCount: retryCount + 1,
        });
      }
    } catch (error) {
      console.error('Error placing target order:', error);
    } finally {
      this.targetLocks.delete(trackKey);
    }
  }

  // async checkAndProcessTarget({
  //   tick,
  //   netPosition,
  //   tradeBook,
  //   instrument,
  //   config, // ✅ ADD
  // }: {
  //   tick: { tk: string; e: string; lp: number };
  //   netPosition: any;
  //   tradeBook: any[];
  //   instrument: any;
  //   config?: {
  //     targetFirst: number;
  //   };
  // }) {
  //   // defining config target value
  //   const TARGET_PERCENT = config?.targetFirst ?? this.TARGET_PERCENT;

  //   const token = tick.tk;
  //   const ltp = tick.lp;

  //   const netQty = Math.abs(Number(netPosition.netqty));
  //   if (netQty <= 0) return;

  //   const positionSide = Number(netPosition.netqty) > 0 ? 'BUY' : 'SELL';
  //   const entryTradeSide = positionSide === 'BUY' ? 'B' : 'S';

  //   const entryTrades = tradeBook
  //     .filter(
  //       (t) =>
  //         t.token === token &&
  //         t.exch === tick.e &&
  //         t.trantype === entryTradeSide,
  //     )
  //     .sort(
  //       (a, b) => new Date(b.exch_tm).getTime() - new Date(a.exch_tm).getTime(),
  //     );

  //   if (!entryTrades.length) return;

  //   const entryTrade = entryTrades[0];
  //   const entryOrderId = entryTrade.norenordno;
  //   const entryPrice = Number(entryTrade.flprc);

  //   if (!entryOrderId) return;

  //   const trackKey = getTargetTrackKey(token, entryOrderId);
  //   const track = readTargetTrack(trackKey);

  //   // ===============================
  //   // 🚀 Time Based Exit
  //   // ===============================
  //   await this.handleTimeBasedExit({
  //     tick,
  //     netPosition,
  //     instrument,
  //     entryOrderId,
  //   });

  //   // ===============================
  //   // 🚫 CHECK IF ALREADY PLACED / CLOSED
  //   // ===============================

  //   // const alreadyPlaced = track?.some(
  //   //   (t) => t.action === 'TARGET_ORDER_PLACED',
  //   // );

  //   // const alreadyBooked = track?.some(
  //   //   (t) => t.action === 'TARGET_BOOKED_50_PERCENT',
  //   // );

  //   // if (alreadyPlaced || alreadyBooked) {
  //   //   return;
  //   // }

  //   // ===============================
  //   // 🚫 CHECK IF ALREADY PLACED / CLOSED
  //   // ===============================
  //   // ===============================
  //   // 🚫 TRADE ALREADY CLOSED
  //   // ===============================
  //   if (isTradeAlreadyClosed(track)) {
  //     return;
  //   }

  //   const alreadyPlaced = track?.some(
  //     (t) => t.action === 'TARGET_ORDER_PLACED',
  //   );

  //   if (alreadyPlaced) return;

  //   // ===============================
  //   // 🚫 ALREADY BOOKED 50% (IMPORTANT FIX)
  //   // ===============================
  //   // const alreadyBooked50 = track?.some(
  //   //   (t) => t.action === 'TARGET_BOOKED_50_PERCENT',
  //   // );

  //   // if (alreadyBooked50) {
  //   //   return; // 🔒 Prevent second partial booking
  //   // }

  //   // ===============================
  //   // 🚫 TRACK AND MARK AND BOOKED 50 PERCENT
  //   // ===============================
  //   const alreadyExecuted = track?.some(
  //     (t) => t.action === 'TARGET_BOOKED_50_PERCENT',
  //   );

  //   // first safety check after time based exit
  //   const placedOrder = track.find((t) => t.action === 'TARGET_ORDER_PLACED');

  //   if (placedOrder?.orderId) {
  //     const matched = tradeBook.find(
  //       (t) => t.norenordno === placedOrder.orderId,
  //     );

  //     if (matched) {
  //       appendTargetTrack(trackKey, {
  //         action: 'TARGET_BOOKED_50_PERCENT',
  //       });
  //       return;
  //     }
  //   }
  //   // second safety check before booking 50 percent
  //   if (!alreadyExecuted) {
  //     const exitSide = positionSide === 'BUY' ? 'S' : 'B';

  //     const exitTrades = tradeBook.filter(
  //       (t) =>
  //         t.token === token && t.exch === tick.e && t.trantype === exitSide,
  //     );

  //     if (exitTrades.length > 0) {
  //       appendTargetTrack(trackKey, {
  //         action: 'TARGET_BOOKED_50_PERCENT',
  //       });

  //       return;
  //     }
  //   }

  //   const side = Number(netPosition.netqty) > 0 ? 'BUY' : 'SELL';

  //   const targetPrice =
  //     side === 'BUY'
  //       ? entryPrice * (1 + TARGET_PERCENT)
  //       : entryPrice * (1 - TARGET_PERCENT);

  //   if (targetPrice <= 0) return;

  //   // const targetHit = side === 'BUY' ? ltp >= targetPrice : ltp <= targetPrice;

  //   // if (!targetHit) return; // no longer waiting for target to hit

  //   const lotSize = Number(instrument.lotSize || instrument.lotsize || 1);

  //   if (netQty <= lotSize) {
  //     return;
  //   }

  //   // const maxCloseQty = Math.floor(netQty / 2);
  //   // const closeQty = Math.floor(maxCloseQty / lotSize) * lotSize;

  //   const rawCloseQty = netQty * this.TARGET_EXIT_PERCENT;

  //   // lot-safe rounding
  //   const closeQty = Math.floor(rawCloseQty / lotSize) * lotSize;

  //   if (closeQty < lotSize) {
  //     return;
  //   }

  //   // ===============================
  //   // 🔒 ADD RETRY LOGIC (CORE CHANGE)
  //   // ===============================
  //   const retryCount = track.filter(
  //     (t) => t.action === 'TARGET_ORDER_RETRY',
  //   ).length;

  //   if (retryCount >= 3) {
  //     return;
  //   }

  //   const lastRetry = [...track]
  //     .reverse()
  //     .find((t) => t.action === 'TARGET_ORDER_RETRY');

  //   if (lastRetry) {
  //     const lastTime = new Date(lastRetry.time).getTime();
  //     if (Date.now() - lastTime < 2000) return;
  //   }

  //   // ===============================
  //   // 🔒 LOCK TO PREVENT DUPLICATE EXECUTION
  //   // ===============================
  //   if (this.targetLocks.has(trackKey)) {
  //     return;
  //   }

  //   this.targetLocks.add(trackKey);

  //   try {
  //     // 🔄 Re-read track inside lock (double safety)
  //     const latestTrack = readTargetTrack(trackKey);
  //     const bookedInsideLock = latestTrack?.some(
  //       (t) => t.action === 'TARGET_BOOKED_50_PERCENT',
  //     );

  //     if (bookedInsideLock) {
  //       return;
  //     }
  //     const alreadyPlacedInsideLock = latestTrack?.some(
  //       (t) => t.action === 'TARGET_ORDER_PLACED',
  //     );

  //     if (alreadyPlacedInsideLock) {
  //       return;
  //     }

  //     // await this.ordersService.placeOrder({
  //     //   buy_or_sell: side === 'BUY' ? 'S' : 'B',
  //     //   product_type: netPosition.prd,
  //     //   exchange: tick.e,
  //     //   tradingsymbol: instrument.tradingSymbol,
  //     //   quantity: closeQty,
  //     //   price_type: 'MKT',
  //     //   retention: 'DAY',
  //     //   remarks: 'AUTO_TARGET_50_PERCENT',
  //     // });
  //     // const roundToTick = (price: number) => Math.round(price * 20) / 20;

  //     // const limitPrice = roundToTick(side === 'BUY' ? ltp - 0.5 : ltp + 0.5);

  //     const roundToTick = (price: number) => Math.round(price * 20) / 20;

  //     let limitPrice = roundToTick(targetPrice);

  //     // safety adjustment
  //     if (side === 'BUY') {
  //       limitPrice = Math.max(limitPrice, ltp);
  //     } else {
  //       limitPrice = Math.min(limitPrice, ltp);
  //     }

  //     // await this.ordersService.placeOrder({
  //     //   buy_or_sell: side === 'BUY' ? 'S' : 'B',
  //     //   product_type: netPosition.prd,
  //     //   exchange: tick.e,
  //     //   tradingsymbol: instrument.tradingSymbol,
  //     //   quantity: closeQty,
  //     //   price_type: 'LMT',
  //     //   price: limitPrice,
  //     //   trigger_price: 0,
  //     //   retention: 'DAY',
  //     //   remarks: 'AUTO_TARGET_50_PERCENT',
  //     // });

  //     // appendTargetTrack(trackKey, {
  //     //   action: 'TARGET_BOOKED_50_PERCENT',
  //     //   entryPrice,
  //     //   targetPrice,
  //     //   originalNetQty: netQty,
  //     //   closeQty,
  //     //   timestamp: new Date().toISOString(),
  //     // });
  //     try {
  //       const res = await this.ordersService.placeOrder({
  //         buy_or_sell: side === 'BUY' ? 'S' : 'B',
  //         product_type: netPosition.prd,
  //         exchange: tick.e,
  //         tradingsymbol: instrument.tradingSymbol,
  //         quantity: closeQty,
  //         price_type: 'LMT',
  //         price: limitPrice,
  //         trigger_price: 0,
  //         retention: 'DAY',
  //         remarks: 'AUTO_TARGET_PENDING',
  //       });

  //       appendTargetTrack(trackKey, {
  //         action: 'TARGET_ORDER_PLACED',
  //         entryPrice,
  //         targetPrice,
  //         closeQty,
  //         orderId: res?.norenordno || null,
  //       });
  //     } catch (err) {
  //       appendTargetTrack(trackKey, {
  //         action: 'TARGET_ORDER_RETRY',
  //         reason: 'ORDER_FAILED',
  //         retryCount: retryCount + 1,
  //       });
  //     }
  //   } catch (error) {
  //     console.error('Error booking partial target:', error);
  //   } finally {
  //     this.targetLocks.delete(trackKey);
  //   }
  // }

  // async checkAndProcessTarget({
  //   tick,
  //   netPosition,
  //   tradeBook,
  //   instrument,
  // }: {
  //   tick: { tk: string; e: string; lp: number };
  //   netPosition: any;
  //   tradeBook: any[];
  //   instrument: any;
  // }) {
  //   const token = tick.tk;
  //   const ltp = tick.lp;

  //   // 🔒 no position → do nothing
  //   const netQty = Math.abs(Number(netPosition.netqty));
  //   if (netQty <= 0) return;

  //   // 🔑 find latest trade (entry trade)
  //   const positionSide = Number(netPosition.netqty) > 0 ? 'BUY' : 'SELL';

  //   const entryTradeSide = positionSide === 'BUY' ? 'B' : 'S';

  //   // 🔒 only trades matching open position side
  //   const entryTrades = tradeBook
  //     .filter(
  //       (t) =>
  //         t.token === token &&
  //         t.exch === tick.e &&
  //         t.trantype === entryTradeSide,
  //     )
  //     .sort(
  //       (a, b) => new Date(b.exch_tm).getTime() - new Date(a.exch_tm).getTime(),
  //     );

  //   if (!entryTrades.length) return;

  //   const entryTrade = entryTrades[0];

  //   const entryOrderId = entryTrade.norenordno;
  //   const entryPrice = Number(entryTrade.flprc);

  //   if (!entryOrderId) return;

  //   // 🔑 per-trade tracking key
  //   const trackKey = getTargetTrackKey(token, entryOrderId);
  //   const track = readTargetTrack(trackKey);

  //   // need to keep this above trade already closed fucntion check
  //   // ===============================
  //   // 🚀 Close open positions ORDER if no new high low hit in given N number of last minutes
  //   // simply calling private fucntion of this class
  //   // ===============================
  //   await this.handleTimeBasedExit({
  //     tick,
  //     netPosition,
  //     instrument,
  //     entryOrderId,
  //   });

  //   // ===============================
  //   // 🚫 TRADE ALREADY CLOSED
  //   // ===============================
  //   if (isTradeAlreadyClosed(track)) {
  //     const skippedCount = countActionReason(
  //       track,
  //       'SKIPPED',
  //       'TRADE_ALREADY_CLOSED',
  //     );

  //     if (skippedCount < 2) {
  //       appendTargetTrack(trackKey, {
  //         action: 'SKIPPED',
  //         reason: 'TRADE_ALREADY_CLOSED',
  //       });
  //     }
  //     return;
  //   }

  //   //const entryPrice = Number(lastTrade.prc);
  //   const side = Number(netPosition.netqty) > 0 ? 'BUY' : 'SELL';

  //   const targetPrice =
  //     side === 'BUY'
  //       ? entryPrice * (1 + this.TARGET_PERCENT)
  //       : entryPrice * (1 - this.TARGET_PERCENT);

  //   const targetHit = side === 'BUY' ? ltp >= targetPrice : ltp <= targetPrice;
  //   console.log(
  //     `Target waiting to be hit for token: ${token} at price: ${targetPrice.toFixed(2)} | LTP: ${ltp},`,
  //   );

  //   // safety check of target price
  //   if (targetPrice <= 0) {
  //     console.log(
  //       `Invalid target price calculated: ${targetPrice} for token: ${token}`,
  //     );
  //     return;
  //   }
  //   if (!targetHit) return;

  //   // ===============================
  //   // 🛑 NOT MORE THAN 1 LOT
  //   // ===============================
  //   const lotSize = Number(instrument.lotSize || instrument.lotsize || 1);

  //   if (netQty <= lotSize) {
  //     if (
  //       canAppendAction(
  //         track,
  //         'TARGET_HIT_NOT_CLOSED',
  //         'NET_QTY_NOT_MORE_THAN_1_LOT',
  //       )
  //     ) {
  //       appendTargetTrack(trackKey, {
  //         action: 'TARGET_HIT_NOT_CLOSED',
  //         reason: 'NET_QTY_NOT_MORE_THAN_1_LOT',
  //         entryPrice,
  //         targetPrice,
  //         netQty,
  //       });
  //     }
  //     return;
  //   }

  //   // ===============================
  //   // ✅ CLOSE EXACT 50% (LOT SAFE)
  //   // ===============================
  //   const maxCloseQty = Math.floor(netQty / 2);
  //   const closeQty = Math.floor(maxCloseQty / lotSize) * lotSize;

  //   if (closeQty < lotSize) {
  //     if (
  //       canAppendAction(
  //         track,
  //         'TARGET_HIT_NOT_CLOSED',
  //         'CLOSE_QTY_LESS_THAN_ONE_LOT_AFTER_ROUNDING',
  //       )
  //     ) {
  //       appendTargetTrack(trackKey, {
  //         action: 'TARGET_HIT_NOT_CLOSED',
  //         reason: 'CLOSE_QTY_LESS_THAN_ONE_LOT_AFTER_ROUNDING',
  //         entryPrice,
  //         targetPrice,
  //         netQty,
  //         calculatedCloseQty: closeQty,
  //       });
  //     }
  //     return;
  //   }

  //   // ===============================
  //   // 🚀 PLACE TARGET ORDER
  //   // ===============================
  //   await this.ordersService.placeOrder({
  //     buy_or_sell: side === 'BUY' ? 'S' : 'B',
  //     product_type: netPosition.prd,
  //     exchange: tick.e,
  //     tradingsymbol: instrument.tradingSymbol,
  //     quantity: closeQty,
  //     price_type: 'MKT',
  //     retention: 'DAY',
  //     remarks: 'AUTO_TARGET_50_PERCENT',
  //   });

  //   appendTargetTrack(trackKey, {
  //     action: 'TARGET_BOOKED_50_PERCENT',
  //     entryPrice,
  //     targetPrice,
  //     netQty,
  //     closeQty,
  //   });
  // }

  // need to keep this above trade already closed fucntion check
  //  =============================== //
  // 🚀 Close open positions ORDER if no new high low hit in given N number of last minutes
  //  ===============================
  private async handleTimeBasedExit({
    tick,
    netPosition,
    instrument,
    entryOrderId,
  }: {
    tick: { tk: string; e: string; lp: number };
    netPosition: any;
    instrument: any;
    entryOrderId: string;
  }) {
    await processTimeBasedExit({
      tick,
      netPosition,
      instrument,
      entryOrderId,
      exitAfterMinutes: Number(this.config.get('TIME_EXIT_MINUTES', 15)),
      closePositionFn: async (side, qty) => {
        // await this.ordersService.placeOrder({
        //   buy_or_sell: side === 'BUY' ? 'S' : 'B',
        //   product_type: netPosition.prd,
        //   exchange: tick.e,
        //   tradingsymbol: instrument.tradingSymbol,
        //   quantity: qty,
        //   price_type: 'MKT',
        //   retention: 'DAY',
        //   remarks: 'AUTO_TIME_EXIT',
        // });
        const ltp = tick.lp;

        // const roundToTick = (price: number) => Math.round(price * 20) / 20;

        const tickSize = Number(
          instrument.tickSize || instrument.tick_size || 0.05,
        );

        const roundToTick = (price: number) =>
          Math.round(price / tickSize) * tickSize;

        const limitPrice = roundToTick(side === 'BUY' ? ltp - 0.5 : ltp + 0.5);

        await this.ordersService.placeOrder({
          buy_or_sell: side === 'BUY' ? 'S' : 'B',
          product_type: netPosition.prd,
          exchange: tick.e,
          tradingsymbol: instrument.tradingSymbol,
          quantity: qty,
          price_type: 'LMT',
          price: limitPrice,
          trigger_price: 0,
          retention: 'DAY',
          remarks: 'AUTO_TIME_EXIT',
        });
      },
    });
  }
}
