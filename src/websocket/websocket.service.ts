import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { TokenService } from '../token/token.service';
import { StrategyService } from 'src/strategy/strategy.service';
import { WS_SUBSCRIPTIONS } from './subscriptions/ws.subscriptions';
import { TradingviewTradeConfigService } from 'src/strategy/tradingview-trade-config/tradingview-trade-config.service';
import { StoplossTargetService } from 'src/strategy/trades/stoploss-target/stoploss-target.service';

const NorenWebSocket = require('norenrestapi/lib/websocket');

@Injectable()
export class WebsocketService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebsocketService.name);
  private ws: any;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isConnected = false;

  constructor(
    private readonly tokenService: TokenService,
    private readonly strategyService: StrategyService,
    private readonly tradeConfigService: TradingviewTradeConfigService,
    private readonly stoplossTargetService: StoplossTargetService,
  ) {}

  /* ===============================
     Lifecycle
  =============================== */

  async onModuleInit() {
    await this.connect();
  }

  onModuleDestroy() {
    if (this.ws) {
      this.ws.close();
      this.logger.warn('🔌 WebSocket closed');
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
  }

  /* ===============================
     Connect WebSocket
  =============================== */

  private async connect() {
    try {
      const token = await this.tokenService.getToken();

      if (!token?.Access_token || !token?.UID || !token?.Account_ID) {
        throw new Error('Invalid token data');
      }

      this.ws = new NorenWebSocket();

      const params = {
        uid: token.UID, // user id
        actid: token.Account_ID, // account id
        apikey: token.Access_token, // access token
      };

      const callbacks = {
        socket_open: async () => {
          this.isConnected = true;
          this.logger.log('✅ Noren WebSocket Connected');

          // 🔔 SUBSCRIBE AFTER CONNECT
          // this.subscribe([
          //   'NSE|22', // RELIANCE
          //   'NSE|1594', // INFY
          //   'NFO|35003', // NIFTY FUT
          //   'MCX|472780', // GOLDM
          // ]);
          // 🔔 subscribe from central config
          //this.subscribeGroup('DEFAULT');
          try {
            await this.subscribeGroup('DEFAULT');
          } catch (error) {
            this.logger.error(
              'Failed to subscribe websocket instruments',
              error.stack,
            );
          }
        },

        socket_close: () => {
          this.isConnected = false;
          this.logger.warn('❌ WebSocket Disconnected');
          this.scheduleReconnect();
        },

        socket_error: (err: any) => {
          this.isConnected = false;
          this.logger.error(`🚨 WS Error: ${this.normalizeError(err)}`);
        },

        // 📈 PRICE FEED COMES HERE
        quote: (tick: any) => {
          // passing tick data to strategy module
          // 🔥 Forward tick to Strategy module
          this.strategyService.onTick(tick);
          this.stoplossTargetService.onTick(tick);

          // console.log(
          //   `📈 PRICE | ${tick.e || ''}|${tick.tk || ''} | LTP: ${
          //     tick.lp
          //   } | Time: ${tick.ft || ''}`,
          // );
          // tick.lp > 0 || tick.bp1 > 0 || tick.sp1 > 0
          //   ? console.log('tick data : ', tick)
          //   : '';
        },

        // 📦 ORDER UPDATES (optional)
        order: (order: any) => {
          this.logger.log(
            `📦 ORDER | ${order?.norenordno ?? ''} | Status: ${
              order?.status ?? ''
            }`,
          );
        },
      };

      await this.ws.connect(params, callbacks);
    } catch (err) {
      this.logger.error('❌ WebSocket init failed', this.normalizeError(err));
      this.scheduleReconnect();
    }
  }

  /* ===============================
     Subscribe Symbols
  =============================== */

  subscribe(keys: string[]) {
    if (!this.ws || !this.isConnected) {
      this.logger.warn('⚠️ WS not connected, cannot subscribe');
      return;
    }

    keys.forEach((key) => {
      const payload = {
        t: 't',
        k: key,
      };

      console.log('📡 Subscribing:', key);
      this.ws.send(JSON.stringify(payload));
    });
  }

  /* ===============================
     Reconnect Logic
  =============================== */

  private scheduleReconnect(delay = 3000) {
    if (this.reconnectTimer) return;

    this.logger.warn(`🔁 Reconnecting WebSocket in ${delay / 1000}s...`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      await this.connect();
    }, delay);
  }

  /* ===============================
     Error Normalization
  =============================== */

  private normalizeError(err: any): string {
    if (!err) return 'Unknown error';
    if (typeof err === 'string') return err;
    if (err?.message) return err.message;
    if (err?.type) return `WebSocket ${err.type}`;
    try {
      return JSON.stringify(err);
    } catch {
      return 'Non-serializable WebSocket error';
    }
  }

  //Subscribe using group name
  // private subscribeGroup(group: keyof typeof WS_SUBSCRIPTIONS) {
  //   const symbols = WS_SUBSCRIPTIONS[group];

  //   if (!symbols?.length) {
  //     this.logger.warn(`No WS subscriptions found for group: ${group}`);
  //     return;
  //   }

  //   this.subscribe(symbols);
  // }

  private async subscribeGroup(group: keyof typeof WS_SUBSCRIPTIONS) {
    // 1️⃣ Static subscriptions
    const staticSymbols = WS_SUBSCRIPTIONS[group] ?? [];

    // 2️⃣ Dynamic subscriptions from DB
    const dynamicSymbols =
      await this.tradeConfigService.getUniqueTokenExchangePairs();

    // 3️⃣ Merge + Deduplicate
    const finalSymbols = Array.from(
      new Set([...staticSymbols, ...dynamicSymbols]),
    );

    if (!finalSymbols.length) {
      this.logger.warn(`No WS subscriptions found for group: ${group}`);
      return;
    }

    this.logger.log(
      `🔔 Subscribing ${finalSymbols.length} instruments [${group}]`,
    );

    this.subscribe(finalSymbols);
  }
}
