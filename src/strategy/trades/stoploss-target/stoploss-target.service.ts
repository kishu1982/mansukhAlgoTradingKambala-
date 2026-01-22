import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { OrdersService } from 'src/orders/orders.service';
import { TickData, SLTargetTrack } from './stoploss-target.types';
import { calcInitialSL, trailSL } from './stoploss-target.utils';

@Injectable()
export class StoplossTargetService {
  private readonly logger = new Logger(StoplossTargetService.name);

  private readonly TRACK_FILE = path.join(
    process.cwd(),
    'data/TVstopossTargetTrack/TV_SL_TGT_tracking.json',
  );

  private readonly FATAL_FILE = path.join(
    process.cwd(),
    'data/TVstopossTargetTrack/TV_SL_FATAL_ERRORS.json',
  );

  private readonly instruments = JSON.parse(
    fs.readFileSync(
      path.join(process.cwd(), 'data/instrumentinfo/instruments.json'),
      'utf8',
    ),
  );

  private readonly SL_PERCENT = Number(
    process.env.STANDARD_STOPLOSS_PERCENT || 0.25,
  );
  private readonly FIRST_STAGE = Number(process.env.FIRST_PROFIT_STAGE || 0.66);
  private readonly BREAKEVEN_STAGE = Number(process.env.BREAKEVEN_STAGE || 0.8);
  private readonly TARGET_FIRST = Number(
    process.env.TARGET_FIRST_PERCENT || 0.25,
  );

  constructor(private readonly orderService: OrdersService) {}

  // =====================================================
  // 🔹 ENTRY FROM WEBSOCKET
  // =====================================================
  async onTick(tick: TickData): Promise<void> {
    try {
      if (!tick?.ls || tick.ls <= 0) return;

      const positions = await this.orderService.getNetPositions();
      if (!Array.isArray(positions?.data)) return;

      const pos = positions.data.find(
        (p) =>
          p.token === tick.tk &&
          p.exch === tick.e &&
          ['I', 'M'].includes(p.prd) &&
          Number(p.netqty) !== 0,
      );

      if (!pos) return;

      const instrument = this.instruments.find(
        (i) => i.exchange === tick.e && i.token === tick.tk,
      );

      if (!instrument?.lotSize || !instrument?.tradingSymbol) {
        this.logger.warn(`Instrument info missing ${tick.e}:${tick.tk}`);
        return;
      }

      await this.manageSLAndTarget({
        exchange: tick.e,
        token: tick.tk,
        tradingSymbol: instrument.tradingSymbol,
        side: Number(pos.netqty) > 0 ? 'BUY' : 'SELL',
        productType: pos.prd,
        openPrice: Number(pos.netavgprc),
        netQty: Number(pos.netqty),
        lotSize: Number(instrument.lotSize),
        ltp: tick.ls,
      });
    } catch (err) {
      this.logger.error('🔥 onTick failed', err?.stack || err);
    }
  }

  // =====================================================
  // 🔹 CORE LOGIC
  // =====================================================
  private async manageSLAndTarget(data: any) {
    try {
      const {
        exchange,
        token,
        tradingSymbol,
        side,
        productType,
        openPrice,
        netQty,
        lotSize,
        ltp,
      } = data;

      this.ensureTrackingFile();

      let track = this.readTrack(exchange, token);
      const openLots = Math.abs(netQty) / lotSize;

      // =====================================================
      // 🔹 STEP 1: CHECK EXISTING PENDING SL (TOKEN BASED)
      // =====================================================
      const pendingSL = await this.findPendingSL(exchange, token);

      // =====================================================
      // 🔹 STEP 2: CREATE INITIAL SL USING LTP (ONLY ONCE)
      // =====================================================
      if (!pendingSL && !track) {
        const sl =
          side === 'BUY'
            ? ltp * (1 - this.SL_PERCENT)
            : ltp * (1 + this.SL_PERCENT);

        const slOrderId = await this.ensureStoplossExists(
          exchange,
          tradingSymbol,
          side,
          productType,
          Math.abs(netQty),
          sl,
        );

        if (!slOrderId) return;

        track = {
          exchange,
          token,
          tradingSymbol,
          side,
          productType,
          openPrice,
          lotSize,
          initialLots: openLots,
          closedLots: 0,
          netQty,
          slTriggerPrice: sl,
          slOrderId,
          stage: 'INITIAL',
          lastAction: 'INITIAL_SL_PLACED',
          targetActions: [],
          updatedAt: new Date().toISOString(),
        };

        this.saveTrack(track);
        this.logger.log(`🛑 Initial SL placed @ ${sl}`);
        return; // ⛔ VERY IMPORTANT (no trailing in same tick)
      }

      if (!track || !pendingSL) return;

      // =====================================================
      // 🔹 PROFIT CALCULATION (FIXED)
      // =====================================================
      const profitPercent =
        side === 'BUY'
          ? (ltp - openPrice) / openPrice
          : (openPrice - ltp) / openPrice;

      // =====================================================
      // 🔹 BREAKEVEN MOVE
      // =====================================================
      if (
        profitPercent >= this.BREAKEVEN_STAGE &&
        track.stage !== 'BREAKEVEN'
      ) {
        track.slTriggerPrice = openPrice;
        track.stage = 'BREAKEVEN';
        track.lastAction = 'SL_TO_BREAKEVEN';

        await this.safeModifySL(track, exchange, tradingSymbol);
      }

      // =====================================================
      // 🔹 FIRST PROFIT TRAIL
      // =====================================================
      else if (profitPercent >= this.FIRST_STAGE && track.stage === 'INITIAL') {
        const trailValue = openPrice * this.SL_PERCENT * this.FIRST_STAGE;
        track.slTriggerPrice = trailSL(ltp, side, trailValue);
        track.stage = 'FIRST_PROFIT';
        track.lastAction = 'FIRST_PROFIT_TRAIL';

        await this.safeModifySL(track, exchange, tradingSymbol);
      }

      // =====================================================
      // 🔹 TARGET LOGIC (UNCHANGED)
      // =====================================================
      const maxClosableLots = Math.floor(track.initialLots / 2);
      const remainingAllowed = maxClosableLots - track.closedLots;

      if (
        openLots > 1 &&
        remainingAllowed > 0 &&
        Math.abs(ltp - openPrice) >= openPrice * this.TARGET_FIRST
      ) {
        const lotsToClose = Math.min(
          Math.floor(openLots / 2),
          remainingAllowed,
        );

        if (lotsToClose >= 1) {
          const closeQty = lotsToClose * lotSize;

          const orderId = await this.orderService.placeOrder({
            buy_or_sell: side === 'BUY' ? 'S' : 'B',
            product_type: this.normalizeProductType(productType),
            exchange,
            tradingsymbol: tradingSymbol,
            quantity: closeQty,
            price_type: 'MKT',
            price: 0,
            retention: 'DAY',
            amo: 'NO',
            remarks: 'TARGET_50_PERCENT_BOOKING',
          });

          track.closedLots += lotsToClose;
          track.netQty =
            side === 'BUY' ? track.netQty - closeQty : track.netQty + closeQty;

          const extractedOrderId = this.extractOrderNo(orderId);

          if (extractedOrderId) {
            track.targetActions.push({
              orderId: extractedOrderId,
              closedLots: lotsToClose,
              remainingLots: track.initialLots - track.closedLots,
              price: ltp,
              time: new Date().toISOString(),
            });
          }

          await this.safeModifySL(track, exchange, tradingSymbol);
          track.lastAction = 'TARGET_50_PERCENT_BOOKED';
        }
      }

      track.updatedAt = new Date().toISOString();
      this.saveTrack(track);
    } catch (err) {
      this.logger.error('🔥 SL/Target execution failed', err?.stack || err);
    }
  }

  // =====================================================
  // 🔹 SAFE SL MODIFY / RECREATE
  // =====================================================
  private async safeModifySL(
    track: SLTargetTrack,
    exchange: string,
    tradingSymbol: string,
  ) {
    const pendingSL = await this.findPendingSL(exchange, track.token);

    if (!pendingSL) {
      const sl = await this.ensureStoplossExists(
        exchange,
        tradingSymbol,
        track.side,
        track.productType,
        Math.abs(track.netQty),
        track.slTriggerPrice,
      );
      if (!sl) return;
      track.slOrderId = sl;
    }

    await this.modifyStoplossOrder(
      track.slOrderId!,
      exchange,
      tradingSymbol,
      track.netQty,
      track.slTriggerPrice,
    );
  }

  // =====================================================
  // 🔹 ORDER HELPERS
  // =====================================================
  private async ensureStoplossExists(
    exchange: string,
    tradingSymbol: string,
    side: 'BUY' | 'SELL',
    productType: string,
    qty: number,
    trigger: number,
  ): Promise<string | null> {
    for (let i = 1; i <= 3; i++) {
      const pending = await this.findPendingSL(exchange, tradingSymbol);
      if (pending) return pending;

      try {
        const res = await this.orderService.placeOrder({
          buy_or_sell: side === 'BUY' ? 'S' : 'B',
          product_type: this.normalizeProductType(productType),
          exchange,
          tradingsymbol: tradingSymbol,
          quantity: qty,
          price_type: 'SL-MKT',
          price: 0,
          trigger_price: trigger,
          retention: 'DAY',
          amo: 'NO',
          remarks: 'AUTO_SL',
        });

        const ord = this.extractOrderNo(res);
        if (ord) return ord;
      } catch (e) {
        this.logger.error(`SL create attempt ${i} failed`, e);
      }
    }

    this.logFatalSLFailure(exchange, tradingSymbol, qty, trigger);
    return null;
  }

  private async modifyStoplossOrder(
    orderId: any,
    exchange: string,
    tradingSymbol: string,
    netQty: number,
    trigger: number,
  ) {
    try {
      const ordNo = this.extractOrderNo(orderId);
      if (!ordNo) return;

      await this.orderService.modifyOrder({
        orderno: ordNo,
        exchange,
        tradingsymbol: tradingSymbol,
        quantity: Math.abs(netQty),
        newprice_type: 'SL-MKT',
        newprice: 0,
        newtrigger_price: trigger,
      });

      this.logger.log(`✏️ SL modified | ${ordNo}`);
    } catch (err) {
      this.logger.error('Modify SL failed', err?.stack || err);
    }
  }

  // finding pending stoploss running in market or not
  // =====================================================
  // 🔹 ORDER HELPERS (UNCHANGED)
  // =====================================================
  private async findPendingSL(
    exchange: string,
    token: string,
  ): Promise<any | null> {
    const ob = await this.orderService.getOrderBook();
    if (!Array.isArray(ob?.trades)) return null;

    return (
      ob.trades.find(
        (o) =>
          o.exch === exchange &&
          o.token === token &&
          o.prctyp === 'SL-MKT' &&
          o.status === 'TRIGGER_PENDING',
      ) || null
    );
  }

  // =====================================================
  // 🔹 FILE HELPERS
  // =====================================================
  private ensureTrackingFile() {
    const dir = path.dirname(this.TRACK_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(this.TRACK_FILE))
      fs.writeFileSync(this.TRACK_FILE, '[]');
  }

  private readTrack(exchange: string, token: string): SLTargetTrack | null {
    try {
      const data = JSON.parse(fs.readFileSync(this.TRACK_FILE, 'utf8'));
      return (
        data.find((d) => d.exchange === exchange && d.token === token) || null
      );
    } catch {
      return null;
    }
  }

  private saveTrack(track: SLTargetTrack) {
    try {
      let data: SLTargetTrack[] = [];
      if (fs.existsSync(this.TRACK_FILE)) {
        data = JSON.parse(fs.readFileSync(this.TRACK_FILE, 'utf8'));
      }
      const i = data.findIndex(
        (d) => d.exchange === track.exchange && d.token === track.token,
      );
      if (i >= 0) data[i] = track;
      else data.push(track);
      fs.writeFileSync(this.TRACK_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
      this.logger.error('Failed to save SL tracking file', err);
    }
  }

  private logFatalSLFailure(
    exchange: string,
    tradingSymbol: string,
    qty: number,
    trigger: number,
  ) {
    const entry = {
      exchange,
      tradingSymbol,
      qty,
      trigger,
      time: new Date().toISOString(),
    };

    let data: any[] = [];
    if (fs.existsSync(this.FATAL_FILE)) {
      data = JSON.parse(fs.readFileSync(this.FATAL_FILE, 'utf8'));
    }

    data.push(entry);
    fs.writeFileSync(this.FATAL_FILE, JSON.stringify(data, null, 2));
  }

  // =====================================================
  // 🔹 UTILS
  // =====================================================
  private extractOrderNo(orderId: any): string | null {
    if (!orderId) return null;
    if (typeof orderId === 'string') return orderId;
    if (typeof orderId === 'object' && orderId.norenordno)
      return orderId.norenordno;
    return null;
  }

  private normalizeProductType(prd: string): 'I' | 'M' | 'C' | 'H' {
    if (['I', 'M', 'C', 'H'].includes(prd)) return prd as any;
    return 'I';
  }
}
