import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import * as fs from 'fs';
import * as path from 'path';
import { OrdersService } from 'src/orders/orders.service';
import { NormalizedTick } from './stoploss-target.types';
import { ConfigService } from '@nestjs/config';

interface CachedBlock<T> {
  data: T;
  updatedAt: number;
}

interface PositionLifecycleState {
  observedSide: 'BUY' | 'SELL';
  observedQty: number;
  observedAt: number;

  confirmedSide?: 'BUY' | 'SELL';
  confirmedQty?: number;
}

@Injectable()
export class StoplossTargetService implements OnModuleInit {
  private readonly logger = new Logger(StoplossTargetService.name);

  // ===============================
  // 🔒 RUNTIME CACHES
  // ===============================
  private netPositions!: CachedBlock<any[]>;
  private orderBook!: CachedBlock<any[]>;
  private tradeBook!: CachedBlock<any[]>;

  // ===============================
  // 🧠 POSITION LIFECYCLE STATE
  // ===============================
  private positionState = new Map<string, PositionLifecycleState>();

  private slPlacementLock = new Set<string>();

  // ===============================
  // 📦 INSTRUMENT MASTER
  // ===============================
  private instruments: any[] = [];

  // ===============================
  // ⚙️ CONFIG
  // ===============================
  private readonly DATA_TTL_MS = 3000;

  // private readonly SL_PERCENT = Number(
  //   process.env.STANDARD_STOPLOSS_PERCENT || 0.25,
  // );
  // private readonly FIRST_PROFIT_STAGE = Number(
  //   process.env.FIRST_PROFIT_STAGE || 0.66,
  // );

  private readonly TRACK_DIR = path.join(
    process.cwd(),
    'data/TVstopossTargetTrack',
  );

  constructor(
    private readonly ordersService: OrdersService,
    private readonly ConfigService: ConfigService,
  ) {}

  // =====================================================
  // 🚀 INIT
  // =====================================================
  async onModuleInit() {
    try {
      this.loadInstruments();
      await this.refreshAllTradingData();
      this.logger.log('✅ StoplossTargetService initialized');
    } catch (e) {
      this.logger.error(
        '⚠️ StoplossTargetService started with partial failure',
        e?.message,
      );
    }

    this.logger.log(
      `📊 SL config | SL_PERCENT=${this.SL_PERCENT} | FIRST_PROFIT_STAGE=${this.FIRST_PROFIT_STAGE}`,
    );
  }
  //defining getters for config values
  private get SL_PERCENT(): number {
    const raw = this.ConfigService.get<string>(
      'STANDARD_STOPLOSS_PERCENT',
      '0.25',
    );

    const value = Number(raw);

    if (Number.isNaN(value)) {
      throw new Error(`Invalid STANDARD_STOPLOSS_PERCENT value: ${raw}`);
    }

    // allow 25 or 0.25
    return value > 1 ? value / 100 : value;
  }

  private get FIRST_PROFIT_STAGE(): number {
    const raw = this.ConfigService.get<string>('FIRST_PROFIT_STAGE', '0.66');

    const value = Number(raw);

    if (Number.isNaN(value)) {
      throw new Error(`Invalid FIRST_PROFIT_STAGE value: ${raw}`);
    }

    // allow 66 or 0.66
    return value > 1 ? value / 100 : value;
  }

  // =====================================================
  // ⏱️ DATA REFRESH
  // =====================================================
  @Interval(1000)
  async refreshAllTradingData() {
    await Promise.all([
      this.refreshNetPositions(),
      this.refreshOrderBook(),
      this.refreshTradeBook(),
    ]);
  }

  private async refreshNetPositions() {
    const res = await this.ordersService.getNetPositions();
    if (Array.isArray(res?.data)) {
      this.netPositions = { data: res.data, updatedAt: Date.now() };
    }
  }

  private async refreshOrderBook() {
    const res = await this.ordersService.getOrderBook();
    if (Array.isArray(res?.trades)) {
      this.orderBook = { data: res.trades, updatedAt: Date.now() };
    }
  }

  private async refreshTradeBook() {
    const res = await this.ordersService.getTradeBook();
    if (Array.isArray(res?.trades)) {
      this.tradeBook = { data: res.trades, updatedAt: Date.now() };
    }
  }

  // =====================================================
  // 📥 INSTRUMENTS
  // =====================================================
  private loadInstruments() {
    this.instruments = JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), 'data/instrumentinfo/instruments.json'),
        'utf8',
      ),
    );
  }

  // =====================================================
  // 📡 ENTRY FROM WEBSOCKET
  // =====================================================
  async onTick(rawTick: any) {
    // this.logger.log(` current sl percent value : ${this.SL_PERCENT}`);
    // this.logger.log(
    //   ` current first profit stage value : ${this.FIRST_PROFIT_STAGE}`,
    // );
    const tick = this.normalizeTick(rawTick);
    if (!tick) return;
    if (!this.isCacheFresh()) return;

    const position = this.findMatchingOpenPosition(tick);
    const pendingSL = this.findPendingSL(tick);

    // ============================
    // CASE-A: POSITION CLOSED
    // ============================
    if (!position && pendingSL) {
      await this.cancelPendingSL(pendingSL, 'NET_POSITION_CLOSED');
      return;
    }

    if (!position) return;

    const side: 'BUY' | 'SELL' = Number(position.netqty) > 0 ? 'BUY' : 'SELL';
    const qty = Math.abs(Number(position.netqty));

    // ============================
    // 🔥 STABILITY + FLIP CHECK
    // ============================
    const posCheck = this.checkPositionStabilityAndFlip(tick.tk, side, qty);

    if (!posCheck.stable) return;

    if (pendingSL && posCheck.flipped) {
      await this.cancelPendingSL(pendingSL, 'POSITION_FLIPPED_REVERSE_SIDE');
      return; // fresh SL on next tick
    }

    const instrument = this.findInstrument(tick);
    if (!instrument) return;

    await this.processRisk({
      tick,
      position,
      instrument,
      pendingSL,
    });
  }

  // =====================================================
  // 🧠 CORE LOGIC — STEP-2
  // =====================================================
  private async processRisk({
    tick,
    position,
    instrument,
    pendingSL,
  }: {
    tick: NormalizedTick;
    position: any;
    instrument: any;
    pendingSL: any | null;
  }) {
    const ltp = tick.lp;
    const side: 'BUY' | 'SELL' = Number(position.netqty) > 0 ? 'BUY' : 'SELL';
    const qty = Math.abs(Number(position.netqty));

    // =====================================================
    // STEP-2 — INITIAL SL
    // =====================================================
    if (!pendingSL) {
      if (this.slPlacementLock.has(tick.tk)) return;
      this.slPlacementLock.add(tick.tk);

      try {
        // 🔥 ALWAYS USE MARKET PRICE SCALE
        const entryPrice = ltp; // tick.lp is true traded price
        const openPrice = Number(position.netavgprc);

       const rawTrigger =
         side === 'BUY'
           ? entryPrice * (1 - this.SL_PERCENT)
           : entryPrice * (1 + this.SL_PERCENT);

       const trigger = this.normalizeTriggerPrice(rawTrigger, instrument, side);

        this.logger.log(
          `DEBUG SL | open=${entryPrice} | SL_PERCENT=${this.SL_PERCENT} | calculated trigger=${trigger}`,
        );
        const res = await this.ordersService.placeOrder({
          buy_or_sell: side === 'BUY' ? 'S' : 'B',
          product_type: position.prd,
          exchange: tick.e,
          tradingsymbol: instrument.tradingSymbol,
          quantity: qty,
          price_type: 'SL-MKT',
          price: 0,
          trigger_price: trigger,
          retention: 'DAY',
          amo: 'NO',
          remarks: 'AUTO_INITIAL_SL',
        });

        const orderId = this.extractOrderNo(res);
        if (!orderId) return;

        const standardDiff = entryPrice * this.SL_PERCENT;

        this.appendOrderLog(orderId, {
          action: 'INITIAL_SL_PLACED',
          side,
          stage: 'STANDARD',

          trigger,
          openPrice,
          entryPrice,

          slPercentUsed: this.SL_PERCENT,
          slDiffUsed: standardDiff,

          highestPrice: side === 'BUY' ? entryPrice : undefined,
          lowestPrice: side === 'SELL' ? entryPrice : undefined,
          qty,
        });

        this.logger.log(`✅ Initial SL placed | ${tick.tk} | ${trigger}`);
      } finally {
        setTimeout(() => this.slPlacementLock.delete(tick.tk), 1200);
      }

      return;
    }

    // =====================================================
    // STEP-2.5 — SYNC SL QUANTITY WITH POSITION
    // =====================================================
    if (pendingSL) {
      await this.syncStoplossQuantityWithPosition(
        tick,
        position,
        instrument,
        pendingSL,
      );
    }

    // =====================================================
    // STEP-3 + STEP-4 — TRAILING WITH FIRST PROFIT STAGE
    // =====================================================
    const orderId = this.extractOrderNo(pendingSL.orderno || pendingSL);
    if (!orderId) return;

    const track = this.readOrderTrack(orderId);
    if (!track.length) return;

    const state = this.deriveTrailingState(track);
    if (!state) return;

    const { openPrice, currentSL, highestPrice, lowestPrice, stage } = state;

    const standardDiff = openPrice * this.SL_PERCENT;
    const firstProfitDiff = standardDiff * this.FIRST_PROFIT_STAGE;

    let activeDiff = standardDiff;
    let nextStage: 'STANDARD' | 'FIRST_PROFIT' | null = null;

    // =====================================================
    // FIRST PROFIT STAGE CHECK (ONE TIME)
    // =====================================================
    if (
      stage === 'STANDARD' &&
      ((side === 'BUY' && ltp >= openPrice + firstProfitDiff) ||
        (side === 'SELL' && ltp <= openPrice - firstProfitDiff))
    ) {
      activeDiff = firstProfitDiff;
      nextStage = 'FIRST_PROFIT';
    }

    if (stage === 'FIRST_PROFIT') {
      activeDiff = firstProfitDiff;
    }

    let newExtreme: number;
    let newSL: number;

    if (side === 'BUY') {
      newExtreme = Math.max(highestPrice ?? openPrice, ltp);
      if (newExtreme <= (highestPrice ?? openPrice)) return;

      newSL = newExtreme - activeDiff;
      if (newSL <= currentSL) return;
    } else {
      newExtreme = Math.min(lowestPrice ?? openPrice, ltp);
      if (newExtreme >= (lowestPrice ?? openPrice)) return;

      newSL = newExtreme + activeDiff;
      if (newSL >= currentSL) return;
    }

    // =====================================================
    // MODIFY SL
    // =====================================================
const normalizedSL = this.normalizeTriggerPrice(newSL, instrument, side);

await this.modifyStoploss(
  orderId,
  tick.e,
  instrument.tradingSymbol,
  qty,
  normalizedSL,
);

    // =====================================================
    // JSON LOG (EVENT-BASED)
    // =====================================================
    const appliedStage = nextStage ?? stage;
    const slPercentUsed =
      appliedStage === 'FIRST_PROFIT'
        ? this.SL_PERCENT * this.FIRST_PROFIT_STAGE
        : this.SL_PERCENT;

    this.appendOrderLog(orderId, {
      action: 'SL_TRAILED',
      side,
      stage: appliedStage,

      previousSL: currentSL,
      newSL,

      slPercentUsed,
      slDiffUsed: activeDiff,

      highestPrice: side === 'BUY' ? newExtreme : undefined,
      lowestPrice: side === 'SELL' ? newExtreme : undefined,
    });

    this.logger.log(`📈 SL trailed | ${tick.tk} | ${currentSL} → ${newSL}`);
  }

  // =====================================================
  // 🔥 POSITION STABILITY + FLIP (CORE FIX)
  // =====================================================
  private checkPositionStabilityAndFlip(
    token: string,
    side: 'BUY' | 'SELL',
    qty: number,
    delayMs = 800,
  ): { stable: boolean; flipped: boolean } {
    const now = Date.now();
    const state = this.positionState.get(token);

    if (!state) {
      this.positionState.set(token, {
        observedSide: side,
        observedQty: qty,
        observedAt: now,
      });
      return { stable: false, flipped: false };
    }

    if (state.observedSide !== side || state.observedQty !== qty) {
      state.observedSide = side;
      state.observedQty = qty;
      state.observedAt = now;
      return { stable: false, flipped: false };
    }

    if (now - state.observedAt < delayMs) {
      return { stable: false, flipped: false };
    }

    const flipped =
      state.confirmedSide !== undefined && state.confirmedSide !== side;

    state.confirmedSide = side;
    state.confirmedQty = qty;

    return { stable: true, flipped };
  }

  // =====================================================
  // 🔎 HELPERS
  // =====================================================
  private normalizeTick(raw: any): NormalizedTick | null {
    const lp = Number(raw?.lp);
    if (!raw || !raw.tk || !raw.e || !Number.isFinite(lp) || lp <= 0)
      return null;
    return { tk: raw.tk, e: raw.e, lp };
  }

  private isCacheFresh(): boolean {
    const now = Date.now();
    return (
      now - this.netPositions?.updatedAt < this.DATA_TTL_MS &&
      now - this.orderBook?.updatedAt < this.DATA_TTL_MS &&
      now - this.tradeBook?.updatedAt < this.DATA_TTL_MS
    );
  }

  private findMatchingOpenPosition(tick: NormalizedTick) {
    return this.netPositions.data.find(
      (p) => p.token === tick.tk && p.exch === tick.e && Number(p.netqty) !== 0,
    );
  }

  private findPendingSL(tick: NormalizedTick) {
    return this.orderBook.data.find(
      (o) =>
        o.token === tick.tk &&
        o.exch === tick.e &&
        o.prctyp === 'SL-MKT' &&
        o.status === 'TRIGGER_PENDING',
    );
  }

  private findInstrument(tick: NormalizedTick) {
    return this.instruments.find(
      (i) => i.exchange === tick.e && i.token === tick.tk,
    );
  }

  private extractOrderNo(o: any): string | null {
    if (!o) return null;
    if (typeof o === 'string') return o;
    if (o.norenordno) return o.norenordno;
    return null;
  }

  private async cancelPendingSL(
    order: any,
    reason: 'NET_POSITION_CLOSED' | 'POSITION_FLIPPED_REVERSE_SIDE',
  ) {
    const orderId = this.extractOrderNo(order.orderno || order);
    if (!orderId) return;

    await this.ordersService.cancelOrder(orderId);

    this.appendOrderLog(orderId, {
      action: 'SL_CANCELLED',
      reason,
    });

    this.logger.warn(`🛑 SL cancelled | ${orderId} | ${reason}`);
  }

  private appendOrderLog(orderId: string, payload: any) {
    if (!fs.existsSync(this.TRACK_DIR))
      fs.mkdirSync(this.TRACK_DIR, { recursive: true });

    const file = path.join(this.TRACK_DIR, `${orderId}.json`);
    const data = fs.existsSync(file)
      ? JSON.parse(fs.readFileSync(file, 'utf8'))
      : [];

    data.push({ ...payload, time: new Date().toISOString() });
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  }

  // =====================================================
  // 🛠️ 3rd step mainking stoploss trails logic helper
  // =====================================================

  // 1️⃣ ADD THIS HELPER (READ TRACK FILE)
  private readOrderTrack(orderId: string): any[] {
    const file = path.join(this.TRACK_DIR, `${orderId}.json`);
    if (!fs.existsSync(file)) return [];
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  //2️⃣ ADD THIS HELPER (MODIFY SL)
  private async modifyStoploss(
    orderId: string,
    exchange: string,
    tradingSymbol: string,
    qty: number,
    trigger: number,
  ) {
    await this.ordersService.modifyOrder({
      orderno: orderId,
      exchange,
      tradingsymbol: tradingSymbol,
      quantity: qty,
      newprice_type: 'SL-MKT',
      newprice: 0,
      newtrigger_price: trigger,
    });
  }

  // helper to add state derivation helper
  private deriveTrailingState(track: any[]): {
    openPrice: number;
    currentSL: number;
    highestPrice?: number;
    lowestPrice?: number;
    stage: 'STANDARD' | 'FIRST_PROFIT';
  } | null {
    let openPrice: number | undefined;
    let currentSL: number | undefined;
    let highestPrice: number | undefined;
    let lowestPrice: number | undefined;
    let stage: 'STANDARD' | 'FIRST_PROFIT' = 'STANDARD';

    for (const entry of track) {
      if (entry.openPrice && openPrice === undefined) {
        openPrice = entry.openPrice;
      }

      if (entry.trigger && currentSL === undefined) {
        currentSL = entry.trigger;
      }

      if (typeof entry.newSL === 'number') {
        currentSL = entry.newSL;
      }

      if (typeof entry.highestPrice === 'number') {
        highestPrice = entry.highestPrice;
      }

      if (typeof entry.lowestPrice === 'number') {
        lowestPrice = entry.lowestPrice;
      }

      if (entry.stage === 'FIRST_PROFIT') {
        stage = 'FIRST_PROFIT';
      }
    }

    if (openPrice === undefined || currentSL === undefined) {
      return null;
    }

    return { openPrice, currentSL, highestPrice, lowestPrice, stage };
  }

  // =====================================================
  // 🛠️ stoploss qunaitity sync logics and functions
  // =====================================================

  //HELPER: EXTRACT SL QTY & SIDE for managing missed qty cases
  private getSLOrderQty(order: any): number | null {
    if (!order) return null;

    const qty = order.qty ?? order.quantity ?? order.trdqty ?? order.fillshares;

    return qty ? Math.abs(Number(qty)) : null;
  }
  private getSLTriggerPrice(order: any): number | null {
    return (
      Number(order.trigprc) ||
      Number(order.trigger_price) ||
      Number(order.trgprc) ||
      null
    );
  }

  //MAIN FUNCTION (CORE REQUIREMENT) TO SYNC SL QTY WITH POSITION QTY
  private async syncStoplossQuantityWithPosition(
    tick: NormalizedTick,
    position: any,
    instrument: any,
    pendingSL: any,
  ) {
    try {
      if (!position || !pendingSL) return;

      const netQty = Math.abs(Number(position.netqty));
      if (netQty <= 0) return;

      const slQty = this.getSLOrderQty(pendingSL);
      if (!slQty) return;

      // No mismatch → nothing to do
      if (slQty === netQty) return;

      const orderId = this.extractOrderNo(pendingSL.orderno || pendingSL);
      if (!orderId) return;

      const trigger = this.getSLTriggerPrice(pendingSL);
      if (!trigger) {
        this.logger.error(
          `❌ Cannot sync SL qty | trigger price missing | order=${orderId}`,
        );
        return;
      }

      
      this.logger.warn(
        `⚠️ SL qty mismatch | token=${tick.tk} | SL=${slQty} | POS=${netQty}`,
      );
      
      // fixing tick size 
      const normalizedTrigger = this.normalizeTriggerPrice(
        trigger,
        instrument,
        position.netqty > 0 ? 'BUY' : 'SELL',
      );

      await this.ordersService.modifyOrder({
        orderno: orderId,
        exchange: tick.e,
        tradingsymbol: instrument.tradingSymbol,
        quantity: netQty,
        newprice_type: 'SL-MKT',
        newprice: 0,
        newtrigger_price: normalizedTrigger, // 🔥 REQUIRED
      });

      this.appendOrderLog(orderId, {
        action: 'SL_QTY_SYNCED',
        previousQty: slQty,
        newQty: netQty,
        triggerPrice: trigger,
      });

      this.logger.log(
        `✅ SL quantity synced | order=${orderId} | ${slQty} → ${netQty}`,
      );
    } catch (err) {
      this.logger.error('❌ Failed to sync SL quantity', err);
    }
  }

  /**
   * Normalize trigger price as per instrument tick size
   *
   * BUY SL  → round DOWN  (safer)
   * SELL SL → round UP    (safer)
   */
  private normalizeTriggerPrice(
    rawPrice: number,
    instrument: any,
    side: 'BUY' | 'SELL',
  ): number {
    const tickSize = Number(instrument?.ti);

    // No tick size → return as is (fallback safety)
    if (!tickSize || !Number.isFinite(tickSize) || tickSize <= 0) {
      return Number(rawPrice.toFixed(2)); // safe default
    }

    const factor = rawPrice / tickSize;

    const normalized =
      side === 'BUY'
        ? Math.floor(factor) * tickSize // BUY SL → below market
        : Math.ceil(factor) * tickSize; // SELL SL → above market

    // Avoid floating precision garbage
    return Number(normalized.toFixed(6));
  }
}
