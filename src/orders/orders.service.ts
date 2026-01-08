import {
  Injectable,
  Logger,
  BadRequestException,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { TokenService } from './../token/token.service';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { AxiosError } from 'axios';

const NorenRestApi = require('norenrestapi/lib/restapi');

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);
  private api: any;

  constructor(
    private readonly tokenService: TokenService,
    private readonly configService: ConfigService,
  ) {
    this.api = new NorenRestApi({});
  }

  async placeOrder(order: {
    buy_or_sell: 'B' | 'S';
    product_type: 'C' | 'M' | 'H';
    exchange: string;
    tradingsymbol: string;
    quantity: number;
    price_type: string;
    price?: number;
    retention?: string;
    remarks?: string;
  }) {
    const token = this.tokenService.getToken();
    const baseUrl = this.configService.get<string>('NOREN_BASE_URL');

    const jData = {
      uid: token.UID,
      actid: token.Account_ID,
      exch: order.exchange,
      tsym: order.tradingsymbol,
      qty: String(order.quantity),
      prc: String(order.price ?? 0),
      prd: order.product_type,
      trantype: order.buy_or_sell,
      prctyp: order.price_type,
      ret: order.retention ?? 'DAY',
      remarks: order.remarks ?? '',
      ordersource: 'API', // 🔥 REQUIRED
    };

    const payload = `jData=${JSON.stringify(jData)}`;

    this.logger.debug(`📤 RAW PlaceOrder → ${payload}`);

    const response = await axios.post(`${baseUrl}/PlaceOrder`, payload, {
      headers: {
        Authorization: `Bearer ${token.Access_token}`,
        'Content-Type': 'application/json',
      },
      transformRequest: [(d) => d],
      timeout: 10000,
    });

    if (response.data?.stat === 'Not_Ok') {
      throw new Error(response.data.emsg);
    }

    return response.data;
  }

  /* ========================= MODIFY ORDER ========================= */

  async modifyOrder(data: {
    orderno: string;
    exchange: string;
    tradingsymbol: string;
    newquantity: number;
    newprice_type: string;
    newprice: number;
    newtrigger_price: number;
    amo?: 'YES' | 'NO';
  }) {
    const token = this.tokenService.getToken();
    const baseUrl = this.configService.get<string>('NOREN_BASE_URL');

    const jData = {
      uid: token.UID,
      actid: token.Account_ID,
      norenordno: data.orderno,
      exch: data.exchange,
      tsym: data.tradingsymbol,
      qty: String(data.newquantity),
      prctyp: data.newprice_type,
      prc: String(data.newprice),
      trgprc: String(data.newtrigger_price),
      amo: data.amo ?? 'NO',
    };

    const payload = `jData=${JSON.stringify(jData)}`;

    this.logger.debug(`📤 MODIFY ORDER → ${payload}`);

    const response = await axios.post(`${baseUrl}/ModifyOrder`, payload, {
      headers: {
        Authorization: `Bearer ${token.Access_token}`,
        'Content-Type': 'application/json',
      },
      transformRequest: [(d) => d],
      timeout: 10000,
    });

    if (response.data?.stat === 'Not_Ok') {
      throw new Error(response.data.emsg);
    }

    return response.data;
  }

  /* ========================= CANCEL ORDER ========================= */

  async cancelOrder(orderno: string) {
    this.logger.log(`📥 Cancel order request → ${orderno}`);

    try {
      const token = this.tokenService.getToken();
      const baseUrl = this.configService.get<string>('NOREN_BASE_URL');

      const jData = {
        uid: token.UID,
        actid: token.Account_ID,
        norenordno: orderno,
      };

      const payload = `jData=${JSON.stringify(jData)}`;

      this.logger.debug(`📤 CANCEL ORDER → ${payload}`);

      const response = await axios.post(`${baseUrl}/CancelOrder`, payload, {
        headers: {
          Authorization: `Bearer ${token.Access_token}`,
          'Content-Type': 'application/json',
        },
        transformRequest: [(d) => d],
        timeout: 10000,
      });

      // ❌ Logical error from Noren
      if (response.data?.stat === 'Not_Ok') {
        this.logger.error(`❌ CancelOrder failed → ${response.data.emsg}`);
        return {
          success: false,
          source: 'NOREN',
          error: response.data.emsg,
          raw: response.data,
        };
      }

      this.logger.log(`✅ Order cancelled successfully → ${orderno}`);

      return {
        success: true,
        data: response.data,
      };
    } catch (error: any) {
      // ❌ Axios error with response
      if (error.response) {
        this.logger.error(`❌ CancelOrder Axios error`, error.response.data);

        return {
          success: false,
          source: 'NETWORK',
          statusCode: error.response.status,
          error: error.response.data,
        };
      }

      // ❌ No response (timeout / DNS)
      if (error.request) {
        this.logger.error(`❌ CancelOrder no response from server`);

        return {
          success: false,
          source: 'NETWORK',
          error: 'No response from Noren API',
        };
      }

      // ❌ Application error
      this.logger.error(`❌ CancelOrder application error`, error.message);

      return {
        success: false,
        source: 'APPLICATION',
        error: error.message || 'Unexpected error',
      };
    }
  }

  /* ========================= EXIT ORDER ========================= */

  async exitOrder(data: { orderno: string; prd: 'H' | 'B' }) {
    this.logger.log(`📥 Exit order request → ${data.orderno}`);

    try {
      const token = this.tokenService.getToken();
      const baseUrl = this.configService.get<string>('NOREN_BASE_URL');

      const jData = {
        uid: token.UID,
        actid: token.Account_ID,
        norenordno: data.orderno,
        prd: data.prd,
      };

      const payload = `jData=${JSON.stringify(jData)}`;

      this.logger.debug(`📤 EXIT ORDER → ${payload}`);

      const response = await axios.post(`${baseUrl}/ExitOrder`, payload, {
        headers: {
          Authorization: `Bearer ${token.Access_token}`,
          'Content-Type': 'application/json',
        },
        transformRequest: [(d) => d],
        timeout: 10000,
      });

      // ❌ Logical error from Noren
      if (response.data?.stat === 'Not_Ok') {
        this.logger.error(`❌ ExitOrder failed → ${response.data.emsg}`);
        return {
          success: false,
          source: 'NOREN',
          error: response.data.emsg,
          raw: response.data,
        };
      }

      this.logger.log(`✅ Exit order successful → ${data.orderno}`);

      return {
        success: true,
        data: response.data,
      };
    } catch (error: any) {
      // ❌ Axios error with response
      if (error.response) {
        this.logger.error(`❌ ExitOrder Axios error`, error.response.data);

        return {
          success: false,
          source: 'NETWORK',
          statusCode: error.response.status,
          error: error.response.data,
        };
      }

      // ❌ No response
      if (error.request) {
        this.logger.error(`❌ ExitOrder no response from server`);

        return {
          success: false,
          source: 'NETWORK',
          error: 'No response from Noren API',
        };
      }

      // ❌ Application error
      this.logger.error(`❌ ExitOrder application error`, error.message);

      return {
        success: false,
        source: 'APPLICATION',
        error: error.message || 'Unexpected error',
      };
    }
  }

  /* ===================== GET ORDER MARGIN ===================== */

  async getOrderMargin(data: {
    exchange: string;
    tradingsymbol: string;
    quantity: number;
    price: number;
    product: string; // C / M / H
    transactionType: 'B' | 'S';
    priceType: string; // LMT / MKT / SL-LMT / SL-MKT
  }) {
    const token = this.tokenService.getToken();
    const baseUrl = this.configService.get<string>('NOREN_BASE_URL');

    const jData = {
      uid: token.UID,
      actid: token.Account_ID,
      exch: data.exchange,
      tsym: data.tradingsymbol,
      qty: String(data.quantity), // MUST be string
      prc: String(data.price), // MUST be string
      prd: data.product,
      trantype: data.transactionType,
      prctyp: data.priceType,
    };

    const payload = `jData=${JSON.stringify(jData)}`;

    this.logger.debug(`📤 GET ORDER MARGIN → ${payload}`);

    try {
      const response = await axios.post(`${baseUrl}/GetOrderMargin`, payload, {
        headers: {
          Authorization: `Bearer ${token.Access_token}`,
          'Content-Type': 'text/plain', // ✅ EXACT MATCH
        },
        transformRequest: [(d) => d],
        timeout: 10000,
      });

      if (response.data?.stat === 'Not_Ok') {
        throw new Error(response.data.emsg);
      }

      return response.data;
    } catch (error) {
      this.logger.error(
        '❌ GetOrderMargin failed',
        error.response?.data || error.message,
      );
      throw error;
    }
  }

  /* ===================== TRADE BOOK ===================== */

  async getTradeBook() {
    try {
      const token = this.tokenService.getToken();
      const baseUrl = this.configService.get<string>('NOREN_BASE_URL');

      if (!token?.Access_token) {
        throw new UnauthorizedException('Access token not found');
      }

      const jData = {
        uid: token.UID,
        actid: token.Account_ID,
      };

      const payload = `jData=${JSON.stringify(jData)}`;

      this.logger.debug(`📤 TRADE BOOK → ${payload}`);

      const response = await axios.post(`${baseUrl}/TradeBook`, payload, {
        headers: {
          Authorization: `Bearer ${token.Access_token}`,
          'Content-Type': 'text/plain',
        },
        transformRequest: [(d) => d],
        timeout: 10000,
      });

      /* ❌ Noren logical error */
      if (response.data?.stat === 'Not_Ok') {
        throw new BadRequestException({
          message: 'TradeBook request failed',
          error: response.data.emsg,
          raw: response.data,
        });
      }

      /* ✅ Success */
      return {
        success: true,
        data: response.data,
      };
    } catch (error) {
      /* ❌ Axios / Network / API error */
      if (error instanceof AxiosError) {
        this.logger.error(
          '❌ TradeBook Axios Error',
          error.response?.data || error.message,
        );

        throw new BadRequestException({
          message: 'Failed to fetch TradeBook from Noren',
          error: error.response?.data || error.message,
        });
      }

      /* ❌ Already handled Nest exception */
      if (
        error instanceof BadRequestException ||
        error instanceof UnauthorizedException
      ) {
        throw error;
      }

      /* ❌ Unknown error */
      this.logger.error('❌ TradeBook Unknown Error', error);

      throw new InternalServerErrorException(
        'Unexpected error while fetching TradeBook',
      );
    }
  }
  /* ===================== POSITION BOOK ===================== */

  async getPositionBook() {
    try {
      const token = this.tokenService.getToken();
      const baseUrl = this.configService.get<string>('NOREN_BASE_URL');

      if (!token?.Access_token) {
        throw new UnauthorizedException('Access token not available');
      }

      const jData = {
        uid: token.UID,
        actid: token.Account_ID,
      };

      const payload = `jData=${JSON.stringify(jData)}`;

      this.logger.debug(`📤 POSITION BOOK → ${payload}`);

      const response = await axios.post(`${baseUrl}/PositionBook`, payload, {
        headers: {
          Authorization: `Bearer ${token.Access_token}`,
          'Content-Type': 'text/plain', // ✅ MUST match curl
        },
        transformRequest: [(d) => d],
        timeout: 10000,
      });

      /* ❌ Noren logical error */
      if (response.data?.stat === 'Not_Ok') {
        throw new BadRequestException({
          message: 'PositionBook request failed',
          error: response.data.emsg,
          raw: response.data,
        });
      }

      /* ✅ Success */
      return {
        success: true,
        data: response.data,
      };
    } catch (error) {
      /* ❌ Axios / API error */
      if (error instanceof AxiosError) {
        this.logger.error(
          '❌ PositionBook Axios Error',
          error.response?.data || error.message,
        );

        throw new BadRequestException({
          message: 'Failed to fetch PositionBook from Noren',
          error: error.response?.data || error.message,
        });
      }

      /* ❌ Already handled */
      if (
        error instanceof BadRequestException ||
        error instanceof UnauthorizedException
      ) {
        throw error;
      }

      /* ❌ Unknown error */
      this.logger.error('❌ PositionBook Unknown Error', error);

      throw new InternalServerErrorException(
        'Unexpected error while fetching PositionBook',
      );
    }
  }

  /* ===================== HOLDINGS ===================== */

  async getHoldings(prd: 'C' | 'M' | 'H' = 'C') {
    try {
      const token = this.tokenService.getToken();
      const baseUrl = this.configService.get<string>('NOREN_BASE_URL');

      if (!token?.Access_token) {
        throw new UnauthorizedException('Access token not available');
      }

      const jData = {
        uid: token.UID,
        actid: token.Account_ID,
        prd,
      };

      const payload = `jData=${JSON.stringify(jData)}`;

      this.logger.debug(`📤 HOLDINGS → ${payload}`);

      const response = await axios.post(`${baseUrl}/Holdings`, payload, {
        headers: {
          Authorization: `Bearer ${token.Access_token}`,
          'Content-Type': 'application/json', // ✅ matches curl
        },
        transformRequest: [(d) => d], // 🚨 REQUIRED
        timeout: 10000,
      });

      /* ❌ Noren logical error */
      if (response.data?.stat === 'Not_Ok') {
        throw new BadRequestException({
          message: 'Holdings request failed',
          error: response.data.emsg,
          raw: response.data,
        });
      }

      /* ✅ Success */
      return {
        success: true,
        data: response.data,
      };
    } catch (error) {
      /* ❌ Axios / API error */
      if (error instanceof AxiosError) {
        this.logger.error(
          '❌ Holdings Axios Error',
          error.response?.data || error.message,
        );

        throw new BadRequestException({
          message: 'Failed to fetch Holdings from Noren',
          error: error.response?.data || error.message,
        });
      }

      /* ❌ Already handled */
      if (
        error instanceof BadRequestException ||
        error instanceof UnauthorizedException
      ) {
        throw error;
      }

      /* ❌ Unknown error */
      this.logger.error('❌ Holdings Unknown Error', error);

      throw new InternalServerErrorException(
        'Unexpected error while fetching Holdings',
      );
    }
  }

  /* ===================== ORDER REPORT ===================== */

  async getOrderReport(data: {
    from_date: string; // DD-MM-YYYY
    to_date: string; // DD-MM-YYYY
    brkname?: string;
  }) {
    try {
      const token = this.tokenService.getToken();
      const baseUrl = this.configService.get<string>('NOREN_BASE_URL');

      if (!token?.Access_token) {
        throw new UnauthorizedException('Access token not available');
      }

      if (!data?.from_date || !data?.to_date) {
        throw new BadRequestException(
          'from_date and to_date are required (DD-MM-YYYY)',
        );
      }

      const jData = {
        actid: token.Account_ID,
        from_date: data.from_date,
        to_date: data.to_date,
        brkname: data.brkname ?? '',
      };

      const payload = `jData=${JSON.stringify(jData)}`;

      this.logger.debug(`📤 ORDER REPORT → ${payload}`);

      const response = await axios.post(`${baseUrl}/GetOrderReport`, payload, {
        headers: {
          Authorization: `Bearer ${token.Access_token}`,
          'Content-Type': 'text/plain', // ✅ MUST match curl
        },
        transformRequest: [(d) => d], // 🚨 REQUIRED
        timeout: 10000,
      });

      /* ❌ Noren logical error */
      if (response.data?.stat === 'Not_Ok') {
        throw new BadRequestException({
          message: 'Order report failed',
          error: response.data.emsg,
          raw: response.data,
        });
      }

      /* ✅ Success */
      return {
        success: true,
        data: response.data,
      };
    } catch (error) {
      /* ❌ Axios / API error */
      if (error instanceof AxiosError) {
        this.logger.error(
          '❌ OrderReport Axios Error',
          error.response?.data || error.message,
        );

        throw new BadRequestException({
          message: 'Failed to fetch Order Report from Noren',
          error: error.response?.data || error.message,
        });
      }

      /* ❌ Already-handled Nest errors */
      if (
        error instanceof BadRequestException ||
        error instanceof UnauthorizedException
      ) {
        throw error;
      }

      /* ❌ Unknown crash */
      this.logger.error('❌ OrderReport Unknown Error', error);

      throw new InternalServerErrorException(
        'Unexpected error while fetching Order Report',
      );
    }
  }
  /* ========================= TRADE REPORT ========================= */

  async getTradeReport(data: {
    from_date: string;
    to_date: string;
    brkname?: string;
  }) {
    try {
      // ✅ Basic validation
      if (!data?.from_date || !data?.to_date) {
        throw new BadRequestException(
          'from_date and to_date are required (DD-MM-YYYY)',
        );
      }

      const token = this.tokenService.getToken();
      const baseUrl = this.configService.get<string>('NOREN_BASE_URL');

      const jData = {
        actid: token.Account_ID,
        from_date: data.from_date,
        to_date: data.to_date,
        brkname: data.brkname ?? '',
      };

      const payload = `jData=${JSON.stringify(jData)}`;

      this.logger.debug(`📤 TRADE REPORT → ${payload}`);

      const response = await axios.post(`${baseUrl}/GetTradeReport`, payload, {
        headers: {
          Authorization: `Bearer ${token.Access_token}`,
          'Content-Type': 'text/plain', // ✅ EXACT as curl
        },
        transformRequest: [(d) => d], // 🚨 REQUIRED
        timeout: 10000,
      });

      // ❌ Noren logical error
      if (response.data?.stat === 'Not_Ok') {
        throw new BadRequestException({
          message: 'Trade report failed',
          error: response.data.emsg,
          raw: response.data,
        });
      }

      return {
        success: true,
        data: response.data,
      };
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }

      if (error instanceof AxiosError) {
        this.logger.error(
          '❌ TradeReport Axios Error',
          error.response?.data || error.message,
        );

        throw new BadRequestException({
          message: 'Failed to fetch trade report',
          error: error.response?.data || error.message,
        });
      }

      this.logger.error(
        '❌ Unexpected TradeReport error',
        error.message,
        error.stack,
      );

      throw new InternalServerErrorException(
        'Unexpected error while fetching trade report',
      );
    }
  }

  /* ========================= NET POSITIONS ========================= */

  async getNetPositions() {
    try {
      const token = this.tokenService.getToken();

      // ✅ Create SDK instance with saved token details
      const api = new NorenRestApi({
        Access_token: token.Access_token,
        UID: token.UID,
        AID: token.Account_ID,
      });

      this.logger.debug('📤 SDK get_positions called');

      const response = await api.get_positions();

      // ❌ Logical error from Noren
      if (response?.stat === 'Not_Ok') {
        throw new BadRequestException({
          message: 'Failed to fetch net positions',
          error: response.emsg,
          raw: response,
        });
      }

      return {
        success: true,
        data: response,
      };
    } catch (error) {
      this.logger.error('❌ SDK get_positions failed', error.message || error);

      if (error instanceof BadRequestException) {
        throw error;
      }

      throw new InternalServerErrorException(
        'Unexpected error while fetching net positions',
      );
    }
  }
}
