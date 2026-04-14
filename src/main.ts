import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { IdempotencyInterceptor } from './idempotency/idempotency.interceptor';
import { PrismaService } from './prisma/prisma.service';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  // Global validation — strip unknown fields, reject invalid DTOs
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Global idempotency interceptor for POST /payments
  const prisma = app.get(PrismaService);
  app.useGlobalInterceptors(new IdempotencyInterceptor(prisma));

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  logger.log(`Payment Provider API running on port ${port}`);
}

bootstrap();
