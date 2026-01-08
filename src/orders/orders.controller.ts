import { Controller, Post, Body, BadRequestException } from '@nestjs/common';
import { OrdersService } from './orders.service';

@Controller('orders')
export class OrdersController {
  constructor(private readonly ordersService: OrdersService) {}

  @Post('place')
  placeOrder(
    @Body()
    body: {
      buy_or_sell: 'B' | 'S';
      product_type: 'C' | 'M' | 'H';
      exchange: string;
      tradingsymbol: string;
      quantity: number;
      price_type: string;
      price?: number;
      trigger_price?: number;
      discloseqty?: number;
      retention?: string;
      amo?: 'YES' | 'NO';
      remarks?: string;
    },
  ) {
    if (
      !body.buy_or_sell ||
      !body.product_type ||
      !body.exchange ||
      !body.tradingsymbol ||
      body.quantity === undefined ||
      !body.price_type
    ) {
      throw new BadRequestException('Missing required order parameters');
    }

    return this.ordersService.placeOrder(body);
  }

  /* ================= MODIFY ================= */

  @Post('modify')
  modifyOrder(@Body() body: any) {
    if (
      !body.orderno ||
      !body.exchange ||
      !body.tradingsymbol ||
      body.newquantity === undefined ||
      !body.newprice_type ||
      body.newprice === undefined ||
      body.newtrigger_price === undefined
    ) {
      throw new BadRequestException('Missing modify order parameters');
    }

    return this.ordersService.modifyOrder(body);
  }

  /* ================= CANCEL ================= */

  @Post('cancel')
  cancelOrder(@Body() body: { orderno: string }) {
    if (!body.orderno) {
      throw new BadRequestException('orderno is required');
    }

    return this.ordersService.cancelOrder(body.orderno);
  }

  /* ================= EXIT ================= */

  @Post('exit')
  exitOrder(@Body() body: { orderno: string; prd: 'H' | 'B' }) {
    if (!body.orderno || !body.prd) {
      throw new BadRequestException('orderno and prd are required');
    }

    return this.ordersService.exitOrder(body);
  }

  @Post('order-margin')
  getOrderMargin(
    @Body()
    body: {
      exchange: string;
      tradingsymbol: string;
      quantity: number;
      price: number;
      product: string;
      transactionType: 'B' | 'S';
      priceType: string;
    },
  ) {
    return this.ordersService.getOrderMargin(body);
  }

  /*============= trade book ======*/
  @Post('trade-book')
  getTradeBook() {
    return this.ordersService.getTradeBook();
  }

  /* ===================== POSITION BOOK ===================== */

  @Post('position-book')
  getPositionBook() {
    return this.ordersService.getPositionBook();
  }

  /* ===================== HOLDINGS ===================== */

  @Post('holdings')
  getHoldings(@Body('prd') prd: 'C' | 'M' | 'H') {
    return this.ordersService.getHoldings(prd || 'C');
  }

  /* ===================== ORDER REPORT ===================== */

  @Post('order-report')
  getOrderReport(
    @Body()
    body: {
      from_date: string;
      to_date: string;
      brkname?: string;
    },
  ) {
    console.log('📥 OrderReport body:', body);
    return this.ordersService.getOrderReport(body);
  }

  /* ========================= TRADE REPORT ========================= */

  @Post('trade-report')
  getTradeReport(
    @Body()
    body: {
      from_date: string;
      to_date: string;
      brkname?: string;
    },
  ) {
    return this.ordersService.getTradeReport(body);
  }

  /* ========================= NET POSITIONS ========================= */

  @Post('net-positions')
  getNetPositions() {
    return this.ordersService.getNetPositions();
  }
}
