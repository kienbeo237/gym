import { z } from 'zod';
import { PhoneVN, Pagination } from './common.js';

export const CreateMemberRequest = z.object({
  phone: PhoneVN,
  fullName: z.string().min(2).max(120),
  email: z.string().email().optional(),
  code: z.string().min(1).max(32).optional(),   // bỏ trống thì hệ thống tự sinh
  dob: z.string().date().optional(),
  gender: z.enum(['MALE', 'FEMALE', 'OTHER']).optional(),
  source: z.string().max(40).optional(),
  note: z.string().max(2000).optional(),
});
export type CreateMemberRequest = z.infer<typeof CreateMemberRequest>;

export const ListMemberQuery = Pagination.extend({
  q: z.string().max(120).optional(),
  status: z.enum(['ACTIVE', 'INACTIVE', 'BANNED']).optional(),
  trainerId: z.string().uuid().optional(),
});
export type ListMemberQuery = z.infer<typeof ListMemberQuery>;

export const MemberSummary = z.object({
  id: z.string().uuid(),
  code: z.string(),
  fullName: z.string(),
  phone: z.string(),
  status: z.string(),
  activePackages: z.number().int(),
  sessionsRemaining: z.number().int(),
  nextBookingAt: z.string().nullable(),
});
export type MemberSummary = z.infer<typeof MemberSummary>;
