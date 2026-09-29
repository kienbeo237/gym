import { BadRequestException, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import type { ZodSchema } from 'zod';

/**
 * Validate bằng chính schema zod khai ở @pt/contracts.
 *
 * Một khai báo, hai đầu dùng: API validate, web suy type. DTO khai hai lần ở
 * hai nơi là hai nơi trôi khỏi nhau, và lệch chỉ lộ ra lúc chạy.
 */
export class ZodPipe<T> implements PipeTransform {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown, _meta: ArgumentMetadata): T {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'Dữ liệu gửi lên không hợp lệ',
        details: parsed.error.issues.map((i) => ({
          field: i.path.join('.'),
          message: i.message,
        })),
      });
    }
    return parsed.data;
  }
}
