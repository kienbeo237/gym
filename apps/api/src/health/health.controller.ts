import { Controller, Get, Inject } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import type { DB } from '@pt/contracts';
import { DB_APP } from '../db/database.module';
import { Public } from '../common/auth.guard';

@Controller('health')
export class HealthController {
  constructor(@Inject(DB_APP) private readonly db: Kysely<DB>) {}

  @Public()
  @Get()
  async check(): Promise<{ status: string; db: string; time: string }> {
    let dbStatus = 'down';
    try {
      await sql`SELECT 1`.execute(this.db);
      dbStatus = 'up';
    } catch {
      dbStatus = 'down';
    }
    return { status: dbStatus === 'up' ? 'ok' : 'degraded', db: dbStatus, time: new Date().toISOString() };
  }
}
