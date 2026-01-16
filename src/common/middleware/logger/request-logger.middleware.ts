import { Injectable, NestMiddleware, Logger } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';

@Injectable()
export class RequestLoggerMiddleware implements NestMiddleware {
  private readonly logger = new Logger('RequestURLLogger');

  use(req: Request, res: Response, next: NextFunction) {
    const sanitizedBody = { ...req.body };

    if (sanitizedBody.password) sanitizedBody.password = '***masked***';
    if (sanitizedBody.token) sanitizedBody.token = '***masked***';

    const logData = {
      method: req.method,
      url: req.originalUrl,
      params: req.params,
      query: req.query,
      body: sanitizedBody,
      headers: {
        'user-agent': req.headers['user-agent'],
        authorization: req.headers['authorization']
          ? '***masked***'
          : undefined,
      },
    };

    // const logData = {
    //   method: req.method,
    //   url: req.originalUrl,
    //   params: req.params,
    //   query: req.query,
    //   body: req.body,
    //   headers: {
    //     'user-agent': req.headers['user-agent'],
    //     authorization: req.headers['authorization']
    //       ? '***masked***'
    //       : undefined,
    //   },
    // };

    this.logger.log(JSON.stringify(logData));

    next(); // VERY IMPORTANT
  }
}
