import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import * as fs from 'fs';
import * as path from 'path';
import { OrdersService } from 'src/orders/orders.service';
import { NormalizedTick } from './stoploss-target.types';
import { ConfigService } from '@nestjs/config';
import { TargetManager } from './target/target.manager';
import { isTradingAllowedForExchange } from 'src/common/utils/trading-time.util';

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
  private refreshLock = false; // to prevent overlapping refreshes

  // adding target logic file properties
  private targetManager: TargetManager;

  private readonly SL_LIMIT_PCT = Number(
    process.env.SL_LIMIT_PRICE_PCT || 0.01,
  );

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

    // this.logger.log(
    //   `📊 SL config | SL_PERCENT=${this.SL_PERCENT} | FIRST_PROFIT_STAGE=${this.FIRST_PROFIT_STAGE}`,
    // );
    this.logger.log(`📊 Dynamic SL config enabled (OPTIDX / FUTIDX mode)`);

    // initializing target manager
    this.targetManager = new TargetManager(
      this.ordersService,
      this.ConfigService,
    );
    this.logger.log('✅ 🎯 TargetManager initialized');
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
    // 🔒 prevent overlapping executions
    if (this.refreshLock) {
      this.logger.debug(
        '⏳ refreshAllTradingData skipped (previous still running)',
      );
      return;
    }

    this.refreshLock = true;

    try {
      // ❗ SERIAL execution (NOT Promise.all)
      await this.refreshNetPositions();
      await this.refreshOrderBook();
      await this.refreshTradeBook();
    } catch (err) {
      this.logger.error('❌ refreshAllTradingData failed', err?.message || err);
    } finally {
      this.refreshLock = false;
    }
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

    // this.logger.log(`Processing tick for token: ${tick.tk} : `, tick);

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

    // ============================
    // Time Restriction Check
    // ============================

    // this.logger.log(` Checking trading time for positions : `, position);
    const exchange = position.exch;
    // this.logger.log(` Checking trading time for exchange : ${exchange} `);

    if (!isTradingAllowedForExchange(exchange, this.ConfigService)) {
      this.logger.warn(
        `⏰ Trading time restricted. Skipping Action on SL-TRAIL / TARGET Findings for ${exchange}|${exchange.token}|${exchange.symbol}`,
      );
      return;
    }

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
    const cfg = this.getConfigForPosition(position); // geting config data of matching positions for target booking

    await this.processRisk({
      tick,
      position,
      instrument,
      pendingSL,
      config: cfg, // ✅ ADD
    });

    // ============================
    // 🔥 TARGET ACQUIREMENT LOGIC
    // ============================
    await this.targetManager.checkAndProcessTarget({
      tick,
      netPosition: position,
      tradeBook: this.tradeBook.data,
      instrument,
      config: cfg, // important to pass config data of target price
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
    config,
  }: {
    tick: NormalizedTick;
    position: any;
    instrument: any;
    pendingSL: any | null;
    config: {
      slPercent: number;
      firstProfit: number;
      breakeven: number;
      targetFirst: number;
    };
  }) {
    const SL_PERCENT = config.slPercent;
    const FIRST_PROFIT_STAGE = config.firstProfit;

    // START ON TICK
    const ltp = tick.lp;
    const side: 'BUY' | 'SELL' = Number(position.netqty) > 0 ? 'BUY' : 'SELL';
    const qty = Math.abs(Number(position.netqty));

    const positionSide: 'BUY' | 'SELL' =
      Number(position.netqty) > 0 ? 'BUY' : 'SELL';

    const slOrderSide: 'BUY' | 'SELL' = positionSide === 'BUY' ? 'SELL' : 'BUY';

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
            ? entryPrice * (1 - SL_PERCENT)
            : entryPrice * (1 + SL_PERCENT);

        const trigger = this.normalizeTriggerPrice(
          rawTrigger,
          instrument,
          side,
        );

        // calculate limit price based on trigger and buffer pct
        const limitPrice = this.calculateSLLimitPrice(
          trigger,
          slOrderSide,
          instrument, // ✅ ADD
        );

        this.logger.log(
          `DEBUG SL | open=${entryPrice} | SL_PERCENT=${SL_PERCENT} | limit price =${limitPrice}| calculated trigger=${trigger}`,
        );
        const res = await this.ordersService.placeOrder({
          buy_or_sell: side === 'BUY' ? 'S' : 'B',
          product_type: position.prd,
          exchange: tick.e,
          tradingsymbol: instrument.tradingSymbol,
          quantity: qty,
          price_type: 'SL-LMT', // ✅ CHANGED
          price: limitPrice, // ✅ REQUIRED
          trigger_price: trigger, // ✅ REQUIRED
          retention: 'DAY',
          amo: 'NO',
          remarks: 'AUTO_INITIAL_SL',
        });

        const orderId = this.extractOrderNo(res);
        if (!orderId) return;

        const standardDiff = entryPrice * SL_PERCENT;

        this.appendOrderLog(orderId, {
          action: 'INITIAL_SL_PLACED',
          side,
          stage: 'STANDARD',

          trigger,
          openPrice,
          entryPrice,

          slPercentUsed: SL_PERCENT,
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

    const standardDiff = openPrice * SL_PERCENT;
    const firstProfitDiff = standardDiff * FIRST_PROFIT_STAGE;

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
      slOrderSide, // ✅ REQUIRED
      instrument, // ✅ ADD
    );

    // =====================================================
    // JSON LOG (EVENT-BASED)
    // =====================================================
    const appliedStage = nextStage ?? stage;
    const slPercentUsed =
      appliedStage === 'FIRST_PROFIT'
        ? SL_PERCENT * FIRST_PROFIT_STAGE
        : SL_PERCENT;

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
        o.prctyp === 'SL-LMT' &&
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
    slOrderSide: 'BUY' | 'SELL', // ✅ ADD THIS
    instrument: any, // ✅ ADD
  ) {
    // calculating limit price based on trigger and buffer pct
    const limitPrice = this.calculateSLLimitPrice(
      trigger,
      slOrderSide,
      instrument, // ✅ ADD
    );
    await this.ordersService.modifyOrder({
      orderno: orderId,
      exchange,
      tradingsymbol: tradingSymbol,
      quantity: qty,
      newprice_type: 'SL-LMT', // ✅ CHANGED
      newprice: limitPrice, // ✅ REQUIRED
      newtrigger_price: trigger, // ✅ REQUIRED
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

      this.logger.log(`pending sl data: ${JSON.stringify(pendingSL)}`);

      // 🔒 IMPORTANT: reuse existing prices exactly
      const existingTrigger = this.extractSLTriggerPrice(pendingSL);
      const existingLimit = this.extractSLLimitPrice(pendingSL);

      if (!existingTrigger || !existingLimit) {
        this.logger.error(
          `❌ Cannot sync SL qty | missing price data | order=${orderId}`,
          pendingSL,
        );
        return;
      }

      this.logger.warn(
        `⚠️ SL qty mismatch | token=${tick.tk} | SL=${slQty} | POS=${netQty}`,
      );

      // ✅ MODIFY ONLY QUANTITY
      await this.ordersService.modifyOrder({
        orderno: orderId,
        exchange: tick.e,
        tradingsymbol: instrument.tradingSymbol,
        quantity: netQty,
        newprice_type: 'SL-LMT',
        newprice: existingLimit, // 🔒 unchanged
        newtrigger_price: existingTrigger, // 🔒 unchanged
      });

      this.appendOrderLog(orderId, {
        action: 'SL_QTY_SYNCED',
        previousQty: slQty,
        newQty: netQty,
        triggerPrice: existingTrigger,
        limitPrice: existingLimit,
      });

      this.logger.log(
        `✅ SL quantity synced | order=${orderId} | ${slQty} → ${netQty}`,
      );
    } catch (err) {
      this.logger.error('❌ Failed to sync SL quantity', err);
    }
  }
  // helper to get triggerprice and limit price exisiting
  private extractSLTriggerPrice(order: any): number | null {
    return order?.trgprc ? Number(order.trgprc) : null;
  }

  private extractSLLimitPrice(order: any): number | null {
    return order?.prc ? Number(order.prc) : null;
  }

  // private async syncStoplossQuantityWithPosition(
  //   tick: NormalizedTick,
  //   position: any,
  //   instrument: any,
  //   pendingSL: any,
  // ) {
  //   try {
  //     if (!position || !pendingSL) return;

  //     const netQty = Math.abs(Number(position.netqty));
  //     if (netQty <= 0) return;

  //     const slQty = this.getSLOrderQty(pendingSL);
  //     if (!slQty) return;

  //     // No mismatch → nothing to do
  //     if (slQty === netQty) return;

  //     const orderId = this.extractOrderNo(pendingSL.orderno || pendingSL);
  //     if (!orderId) return;

  //     const trigger = this.getSLTriggerPrice(pendingSL);
  //     if (!trigger) {
  //       this.logger.error(
  //         `❌ Cannot sync SL qty | trigger price missing | order=${orderId}`,
  //       );
  //       return;
  //     }

  //     this.logger.warn(
  //       `⚠️ SL qty mismatch | token=${tick.tk} | SL=${slQty} | POS=${netQty}`,
  //     );

  //     // fixing tick size
  //     const normalizedTrigger = this.normalizeTriggerPrice(
  //       trigger,
  //       instrument,
  //       position.netqty > 0 ? 'BUY' : 'SELL',
  //     );
  //     // finding side and making limit price based on trigger price
  //     const side: 'BUY' | 'SELL' = Number(position.netqty) > 0 ? 'BUY' : 'SELL';
  //     const limitPrice = this.calculateSLLimitPrice(
  //       normalizedTrigger,
  //       side,
  //       instrument, // ✅ ADD
  //     );

  //     await this.ordersService.modifyOrder({
  //       orderno: orderId,
  //       exchange: tick.e,
  //       tradingsymbol: instrument.tradingSymbol,
  //       quantity: netQty,
  //       newprice_type: 'SL-LMT',
  //       newprice: limitPrice,
  //       newtrigger_price: normalizedTrigger, // 🔥 REQUIRED
  //     });

  //     this.appendOrderLog(orderId, {
  //       action: 'SL_QTY_SYNCED',
  //       previousQty: slQty,
  //       newQty: netQty,
  //       triggerPrice: trigger,
  //     });

  //     this.logger.log(
  //       `✅ SL quantity synced | order=${orderId} | ${slQty} → ${netQty}`,
  //     );
  //   } catch (err) {
  //     this.logger.error('❌ Failed to sync SL quantity', err);
  //   }
  // }

  /**
   * Normalize trigger price so that:
   * 1) It is an EXACT multiple of tick size
   * 2) Direction-safe (BUY floor, SELL ceil)
   * 3) No floating-point drift
   */
  private normalizeTriggerPrice(
    rawPrice: number,
    instrument: any,
    side: 'BUY' | 'SELL',
  ): number {
    try {
      const tickSizeRaw = instrument?.tickSize ?? instrument?.raw?.TickSize;

      if (!tickSizeRaw) {
        this.logger.error(
          `❌ Tick size missing | symbol=${instrument?.tradingSymbol}`,
        );
        return Number(rawPrice.toFixed(2));
      }

      const tickSizeStr = String(tickSizeRaw).trim();
      const tickSize = Number(tickSizeStr);

      if (!Number.isFinite(tickSize) || tickSize <= 0) {
        this.logger.error(
          `❌ Invalid tick size "${tickSizeRaw}" | symbol=${instrument?.tradingSymbol}`,
        );
        return Number(rawPrice.toFixed(2));
      }

      // 🔒 INTEGER TICK MATH — NO FLOAT MODULO
      const ticks = rawPrice / tickSize;

      const roundedTicks =
        side === 'BUY' ? Math.floor(ticks) : Math.ceil(ticks);

      const normalized = roundedTicks * tickSize;

      // decimals derived from tick size STRING
      const decimals = tickSizeStr.includes('.')
        ? tickSizeStr.split('.')[1].length
        : 0;

      const finalPrice = Number(normalized.toFixed(decimals));

      this.logger.log(
        `TICK_CHECK | raw=${rawPrice} | tick=${tickSizeStr} | final=${finalPrice}`,
      );

      return finalPrice;
    } catch (err) {
      this.logger.error(
        `❌ Tick normalization failed | raw=${rawPrice}`,
        err?.message || err,
      );
      return Number(rawPrice.toFixed(2));
    }
  }

  //reusable helper function for calculating sl limit price
  private calculateSLLimitPrice(
    triggerPrice: number,
    slOrderSide: 'BUY' | 'SELL',
    instrument: any,
  ): number {
    const buffer = triggerPrice * this.SL_LIMIT_PCT;

    // 🔒 RAW price must already be on correct side
    const rawPrice =
      slOrderSide === 'SELL'
        ? triggerPrice - buffer // SELL SL → BELOW trigger
        : triggerPrice + buffer; // BUY SL → ABOVE trigger

    return this.normalizeLimitPrice(rawPrice, instrument, slOrderSide);
  }
  // helper to normallize limit price
  private normalizeLimitPrice(
    rawPrice: number,
    instrument: any,
    side: 'BUY' | 'SELL',
  ): number {
    try {
      const tickSizeRaw = instrument?.tickSize ?? instrument?.raw?.TickSize;
      if (!tickSizeRaw) return Number(rawPrice.toFixed(2));

      const tickSizeStr = String(tickSizeRaw).trim();
      const tickSize = Number(tickSizeStr);
      if (!Number.isFinite(tickSize) || tickSize <= 0)
        return Number(rawPrice.toFixed(2));

      const ticks = rawPrice / tickSize;

      // 🔥 OPPOSITE rounding vs trigger
      const roundedTicks =
        side === 'SELL' ? Math.floor(ticks) : Math.ceil(ticks);

      const normalized = roundedTicks * tickSize;

      const decimals = tickSizeStr.includes('.')
        ? tickSizeStr.split('.')[1].length
        : 0;

      return Number(normalized.toFixed(decimals));
    } catch {
      return Number(rawPrice.toFixed(2));
    }
  }

  // ===============================
  // HELPER TO RESOLVE CONFIG FOR STOPLOSS TRAILING BASED ON OPTINX AND FUTIDX
  // ===============================

  private getConfigForPosition(position: any) {
    const inst = position?.instname;
    const sym = position?.symname;

    // DEFAULT (existing behavior)
    let slPercent = this.SL_PERCENT;
    let firstProfit = this.FIRST_PROFIT_STAGE;
    let breakeven = Number(this.ConfigService.get('BREAKEVEN_STAGE', '0.8'));
    let targetFirst = Number(
      this.ConfigService.get('TARGET_FIRST_PERCENT', '0.25'),
    );

    // ===============================
    // OPTIDX
    // ===============================
    if (inst === 'OPTIDX') {
      slPercent = this.getEnvNumber('STANDARD_STOPLOSS_PERCENT_OPTIDX', 0.25);
      firstProfit = this.getEnvNumber('FIRST_PROFIT_STAGE_OPTIDX', 0.6);
      breakeven = this.getEnvNumber('BREAKEVEN_STAGE_OPTIDX', 0.8);
      targetFirst = this.getEnvNumber('TARGET_FIRST_PERCENT_OPTIDX', 0.25);
    }

    // ===============================
    // FUTIDX
    // ===============================
    else if (inst === 'FUTIDX') {
      // BANKNIFTY special override
      if (sym === 'BANKNIFTY') {
        slPercent = this.getEnvNumber(
          'STANDARD_STOPLOSS_PERCENT_FUTIDX_BANKNIFTY',
          0.0033,
        );
        targetFirst = this.getEnvNumber(
          'TARGET_FIRST_PERCENT_FUTIDX_BANKNIFTY',
          0.033,
        );
      } else {
        slPercent = this.getEnvNumber(
          'STANDARD_STOPLOSS_PERCENT_FUTIDX',
          0.0025,
        );
        targetFirst = this.getEnvNumber('TARGET_FIRST_PERCENT_FUTIDX', 0.025);
      }

      firstProfit = this.getEnvNumber('FIRST_PROFIT_STAGE_FUTIDX', 0.6);
      breakeven = this.getEnvNumber('BREAKEVEN_STAGE_FUTIDX', 0.8);
    }

    return {
      slPercent,
      firstProfit,
      breakeven,
      targetFirst,
    };
  }

  private getEnvNumber(key: string, defaultValue: number): number {
    const raw = this.ConfigService.get<string>(key, String(defaultValue));
    const value = Number(raw);

    if (Number.isNaN(value)) return defaultValue;

    return value > 1 ? value / 100 : value;
  }
}
