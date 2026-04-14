import { IsInt, IsString, IsOptional, IsObject, Min, Length } from 'class-validator';

export class CreatePaymentDto {
  @IsInt()
  @Min(1)
  amount: number;

  @IsString()
  @Length(3, 3)
  currency: string;

  @IsString()
  merchantId: string;

  @IsString()
  idempotencyKey: string;

  @IsString()
  webhookUrl: string;

  @IsString()
  cardToken: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
