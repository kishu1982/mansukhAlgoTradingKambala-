import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FinalTradeToBePlacedEntity } from './entities/final-trade-to-be-placed.entity';
import { MongoRepository } from 'typeorm';
import { getISTTradeDate } from 'src/common/utils/date.util';
import { TradingViewSignalEntity } from 'src/database/entities/tradingview-signal.entity';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class TradesService {
  private readonly logger = new Logger(TradesService.name);
  
  // =====================================================
  // 🔹 TIME CONFIG (IST)
  // =====================================================
  // Just declare — do NOT initialize yet
  private readonly MARKET_START_TIME: string;
  private readonly MARKET_CUTOFF_TIME: string;

  private readonly TIME_RESTRICTED_EXCHANGES = new Set([
    'NSE', 'NFO', 'BSE', 'BFO',
  ]);


  constructor(
    @InjectRepository(FinalTradeToBePlacedEntity)
    private readonly finalTradeRepo: MongoRepository<FinalTradeToBePlacedEntity>, private readonly configService: ConfigService,
  ) {

    // ← now it's safe
    this.MARKET_START_TIME  = this.configService.get<string>('TRADING_START_TIME', '09:15');   // ← add fallback if possible
    this.MARKET_CUTOFF_TIME = this.configService.get<string>('TRADING_END_TIME',   '15:30');
  }

  

  // =====================================================
  // 🔹 IST TIME CHECK
  // =====================================================
  private isWithinTradingTime(): boolean {
    const now = new Date(
      new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }),
    );
    const [sh, sm] = this.MARKET_START_TIME.split(':').map(Number);
    const [eh, em] = this.MARKET_CUTOFF_TIME.split(':').map(Number);

    const start = new Date(now);
    start.setHours(sh, sm, 0, 0);

    const end = new Date(now);
    end.setHours(eh, em, 0, 0);

    return now >= start && now <= end;
  }

  /**
   * Create all saved trades
   *
   */
  async createFinalTrades(signal: TradingViewSignalEntity, configs: any[]) {
     this.logger.log('🚀 Starting generating signals cycle');
     
// time check
const exchange = signal.exchange;

// Apply time restriction ONLY for restricted exchanges
if (
  this.TIME_RESTRICTED_EXCHANGES.has(exchange) &&
  !this.isWithinTradingTime()
) {
  this.logger.warn(
    `⏰ Trading time over. Not creating trade signal for ${exchange}|${signal.token}|${signal.symbol}`
  );
  return; // stop this signal only
}

// time check ends

// ✅ next steps: create trade signal data


    const tradeDate = getISTTradeDate();

    // ✅ IMPORTANT FIX
    const trades: FinalTradeToBePlacedEntity[] = [];

    for (const config of configs) {
      for (let i = 0; i < config.toBeTradedOn.length; i++) {
        const leg = config.toBeTradedOn[i];

        trades.push({
          sourceSignalId: signal._id,
          strategyName: config.strategyName,

          exchange: leg.exchange,
          symbol: leg.symbolName,
          token: leg.tokenNumber,
          side: leg.side,
          quantityLots: leg.quantityLots,
          productType: leg.productType,

          legNumber: i + 1,
          totalLegs: config.legs,

          tradeStatus: 'PENDING',
          tradeDate,
          createdAt: new Date(), // 👈 manual
        } as FinalTradeToBePlacedEntity); // 👈 optional but safe
      }
    }

    await this.finalTradeRepo.insertMany(trades);
  }

  /**
   * Get all saved trades
   * Optional filters can be added later (date, status, strategy)
   */
  async getAllTrades(): Promise<FinalTradeToBePlacedEntity[]> {
    try {
      const trades = await this.finalTradeRepo.find({
        order: {
          createdAt: 'DESC',
        },
      });

      this.logger.log(`Fetched ${trades.length} trades from database`);
      return trades;
    } catch (err) {
      this.logger.error('Failed to fetch trades from database', err?.stack);
      return []; // never crash
    }
  }

  //Get all pending trades with pending status

  async getPendingTrades(): Promise<FinalTradeToBePlacedEntity[]> {
    return this.finalTradeRepo.find({
      where: {
        tradeStatus: 'PENDING',
      },
      order: {
        createdAt: 'ASC',
      },
    });
  }

  async markTradePlaced(tradeId: any): Promise<void> {
    try {
      await this.finalTradeRepo.updateOne(
        { _id: tradeId },
        { $set: { tradeStatus: 'PLACED' } },
      );
    } catch (err) {
      this.logger.error(
        `Failed to mark trade PLACED | tradeId=${tradeId}`,
        err?.stack,
      );
    }
  }

  //Add FAILED status updater in TradesService
  async markTradeFailed(tradeId: any, reason?: string): Promise<void> {
    try {
      await this.finalTradeRepo.updateOne(
        { _id: tradeId },
        {
          $set: {
            tradeStatus: 'FAILED',
            failureReason: reason || 'UNKNOWN',
          },
        },
      );
    } catch (err) {
      this.logger.error(
        `Failed to mark trade FAILED | tradeId=${tradeId}`,
        err?.stack,
      );
    }
  }
}

