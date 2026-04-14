import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  BadRequestException,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Intercepts POST /payments requests.
 * If the Idempotency-Key header matches a cached response, return it immediately.
 * Otherwise, execute the handler and cache the response.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly TTL_HOURS = 24;

  constructor(private readonly prisma: PrismaService) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<any>> {
    const request = context.switchToHttp().getRequest();
    const response = context.switchToHttp().getResponse();

    // Only enforce idempotency on POST /payments (creation endpoint)
    if (request.method !== 'POST' || request.path !== '/payments') {
      return next.handle();
    }

    const idempotencyKey = request.headers['idempotency-key'];
    const merchantId = request.headers['x-merchant-id'] ?? request.body?.merchantId;

    if (!idempotencyKey) {
      throw new BadRequestException('Idempotency-Key header is required');
    }

    const cached = await this.prisma.idempotencyKey.findUnique({
      where: { key: `${merchantId}:${idempotencyKey}` },
    });

    if (cached) {
      response.status(cached.statusCode);
      return new Observable((subscriber) => {
        subscriber.next(cached.responseBody);
        subscriber.complete();
      });
    }

    return next.handle().pipe(
      tap(async (responseBody) => {
        await this.prisma.idempotencyKey.upsert({
          where: { key: `${merchantId}:${idempotencyKey}` },
          create: {
            key: `${merchantId}:${idempotencyKey}`,
            merchantId,
            responseBody,
            statusCode: response.statusCode,
            expiresAt: new Date(Date.now() + this.TTL_HOURS * 60 * 60 * 1000),
          },
          update: {},
        });
      }),
    );
  }
}
