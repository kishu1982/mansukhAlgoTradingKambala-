import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class StrategyService {
  private readonly logger = new Logger(StrategyService.name);

  /**
   * Called for every tick coming from WebSocket
   */
  onTick(tickData: any): void {
    // Raw tick logging
    //this.logger.log(`Tick Received: ${JSON.stringify(tickData)}`);
    tickData.lp > 0 || tickData.bp1 > 0 || tickData.sp1 > 0
      ? console.log('tick data : ', tickData)
      : '';

    // Later you can route to strategies:
    // this.runScalpingStrategy(tickData);
    // this.runVWAPStrategy(tickData);
  }

  // Example placeholder strategy
  private runScalpingStrategy(tick: any) {
    // logic here
    
  }
}
