import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

/**
 * 重试理解的幂等键：每次点击生成新的 UUID，让每一次重试拥有独立的请求作用域
 * 与预算账户（同一 attemptId 的重复提交被 Grant 一次性语义挡住）。
 */
export class RetryUnderstandingDto {
  @ApiProperty({ format: 'uuid', description: '本次重试尝试的客户端幂等键' })
  @IsUUID()
  attemptId!: string;
}
