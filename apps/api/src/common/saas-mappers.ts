import type { SaasInvoice, SaasInvoiceStatus } from '@pt/contracts';

/** Cột của tenant_billing_record (kèm tên gói) mà cả hai phía cùng đọc. */
export const COT_HOA_DON_SAAS = [
  'b.id',
  'b.period_start',
  'b.period_end',
  'b.plan_code',
  'pl.name as plan_name',
  'b.amount',
  'b.status',
  'b.due_date',
  'b.transfer_ref',
  'b.paid_amount',
  'b.confirmed_at',
  'b.note',
  'b.created_at',
] as const;

type Dong = {
  id: string;
  period_start: string;
  period_end: string;
  plan_code: string;
  plan_name: string;
  amount: string | number | bigint;
  status: string;
  due_date: string;
  transfer_ref: string;
  paid_amount: string | number | bigint | null;
  confirmed_at: Date | string | null;
  note: string | null;
  created_at: Date | string;
};

const iso = (v: Date | string) => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

export function hoaDonSaas(r: Dong): SaasInvoice {
  return {
    id: r.id,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    planCode: r.plan_code,
    planName: r.plan_name,
    amount: Number(r.amount),
    status: r.status as SaasInvoiceStatus,
    dueDate: r.due_date,
    transferRef: r.transfer_ref,
    paidAmount: r.paid_amount === null ? null : Number(r.paid_amount),
    confirmedAt: r.confirmed_at ? iso(r.confirmed_at) : null,
    note: r.note,
    createdAt: iso(r.created_at),
  };
}

export function goiSaas(p: {
  code: string;
  name: string;
  price_monthly: string | number | bigint;
  max_members: number | null;
  max_trainers: number | null;
  max_messages_month: number | null;
  is_public: boolean;
}) {
  return {
    code: p.code,
    name: p.name,
    priceMonthly: Number(p.price_monthly),
    maxMembers: p.max_members,
    maxTrainers: p.max_trainers,
    maxMessagesMonth: p.max_messages_month,
    isPublic: p.is_public,
  };
}
