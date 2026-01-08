import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { TokenService } from '../token/token.service';

const NorenWebSocket = require('norenrestapi/lib/websocket');

@Injectable()
export class WebsocketService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WebsocketService.name);
  private ws: any;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isConnected = false;

  constructor(private readonly tokenService: TokenService) {}

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
        socket_open: () => {
          this.isConnected = true;
          this.logger.log('✅ Noren WebSocket Connected');

          // 🔔 SUBSCRIBE AFTER CONNECT
          this.subscribe([
            'NSE|22', // RELIANCE
            'NSE|1594', // INFY
            'NFO|35003', // NIFTY FUT
            'MCX|472780', // GOLDM
          ]);
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
          console.log(
            `📈 PRICE | ${tick.e || ''}|${tick.tk || ''} | LTP: ${
              tick.lp
            } | Time: ${tick.ft || ''}`,
          );
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
}

// working fine directly like post man
// import {
//   Injectable,
//   Logger,
//   OnModuleInit,
//   OnModuleDestroy,
// } from '@nestjs/common';
// import { TokenService } from '../token/token.service';
// import { ConfigService } from '@nestjs/config';
// import WebSocket from 'ws';

// @Injectable()
// export class WebsocketService implements OnModuleInit, OnModuleDestroy {
//   private readonly logger = new Logger(WebsocketService.name);
//   private ws: WebSocket;
//   private isAuthorized = false;

//   constructor(
//     private readonly tokenService: TokenService,
//     private readonly configService: ConfigService,
//   ) {}

//   onModuleInit() {
//     this.connect();
//   }

//   onModuleDestroy() {
//     this.ws?.close();
//   }

//   connect() {
//     const wsUrl = this.configService.get<string>('NOREN_WEBSOCKET_URL');

//     const token = this.tokenService.getToken();

//     this.logger.log(`🔌 Connecting → ${wsUrl}`);

//     this.ws = new WebSocket(wsUrl);

//     this.ws.on('open', () => {
//       this.logger.log('✅ WebSocket Open');

//       // 🔐 AUTH PAYLOAD (EXACT POSTMAN MATCH)
//       const authPayload = {
//         t: 'a',
//         uid: token.UID,
//         actid: token.Account_ID,
//         accesstoken: token.Access_token,
//         source: 'API',
//       };

//       this.ws.send(JSON.stringify(authPayload));
//       this.logger.log('🔐 Auth sent');
//     });

//     this.ws.on('message', (raw) => {
//       const msg = raw.toString();
//       this.logger.debug(`⬇️ WS RAW → ${msg}`);

//       let data: any;
//       try {
//         data = JSON.parse(msg);
//       } catch {
//         return;
//       }

//       /* ================= AUTH ACK ================= */
//       if (data.t === 'ak' && data.s === 'OK') {
//         this.logger.log('🔐 AUTH OK – subscribing now');
//         this.isAuthorized = true;

//         // Important small delay
//         setTimeout(() => this.subscribeDefaults(), 200);
//         return;
//       }

//       /* ================= LIVE TICKS ================= */

//       if (data.t === 'tk') {
//         this.logger.log(`📈 ${data.tsym} | LTP=${data.lp} | Vol=${data.v}`);
//         return;
//       }

//       /* ================= OTHER ================= */

//       this.logger.debug('ℹ️ WS MSG', data);
//     });

//     this.ws.on('close', () => {
//       this.logger.warn('⚠️ WebSocket Closed');
//       this.isAuthorized = false;
//     });

//     this.ws.on('error', (err) => {
//       this.logger.error('❌ WebSocket Error', err);
//     });
//   }

//   /* ================= SUBSCRIBE ================= */

//   subscribeDefaults() {
//     if (!this.isAuthorized) {
//       this.logger.warn('⛔ Cannot subscribe – not authorized');
//       return;
//     }

//     const instruments = [
//       'NSE|22', // RELIANCE
//       'NSE|1594', // INFY
//       'NFO|35003', // NIFTY FUT
//       'MCX|487866', // GOLDM
//     ];

//     instruments.forEach((inst) => {
//       const payload = { t: 't', k: inst };
//       this.logger.log(`📡 Subscribing → ${inst}`);
//       this.ws.send(JSON.stringify(payload));
//     });
//   }
//   handleMessage(raw: any) {
//     try {
//       const data = typeof raw === 'string' ? JSON.parse(raw) : raw;

//       /* ========== AUTH ACK (REAL) ========== */
//       if (data.t === 'ak' && data.s === 'OK') {
//         this.logger.log('🔐 AUTH OK – subscribing');
//         this.isAuthorized = true;

//         setTimeout(() => this.subscribeDefaults(), 200);
//         return;
//       }

//       /* ========== LIVE TICKS ========== */
//       if (data.t === 'tk') {
//         this.logger.log(`📈 ${data.tsym} | LTP=${data.lp} | Vol=${data.v}`);
//         return;
//       }

//       /* ========== OTHER ========== */
//       this.logger.debug('ℹ️ WS MSG', data);
//     } catch (err) {
//       this.logger.error('❌ WS parse error', err);
//     }
//   }
// }
