'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import * as Popover from '@radix-ui/react-popover';
import { Bell, CalendarDays, CheckCheck, Clock, TriangleAlert } from 'lucide-react';
import type { InboxList, StaffNotificationKind } from '@pt/contracts';
import { goiApi } from '../lib/client-api';

/** Chuông hỏi lại mỗi phút — worker sinh thông báo theo nhịp 5 phút nên không cần nhanh hơn. */
const NHIP_MS = 60_000;

const ICON: Record<StaffNotificationKind, typeof Bell> = {
  PT_UPCOMING: Clock,
  PT_AGENDA: CalendarDays,
  UNCHECKED: TriangleAlert,
};

function luc(iso: string): string {
  const phut = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (phut < 1) return 'vừa xong';
  if (phut < 60) return `${phut} phút trước`;
  const gio = Math.floor(phut / 60);
  if (gio < 24) return `${gio} giờ trước`;
  return new Date(iso).toLocaleDateString('vi-VN', { day: '2-digit', month: '2-digit' });
}

export type Inbox = {
  data: InboxList | null;
  tai: () => Promise<void>;
  docMot: (id: string) => void;
  docHet: () => Promise<void>;
};

/**
 * Một nguồn dữ liệu cho cả hai chuông (thanh bên trên máy tính, thanh trên cùng
 * trên điện thoại) — gọi API một lần, không phải hai. Tab ẩn thì thôi hỏi.
 */
export function useInbox(bat: boolean): Inbox {
  const [data, setData] = useState<InboxList | null>(null);

  const tai = useCallback(async () => {
    if (!bat || document.visibilityState === 'hidden') return;
    try {
      setData(await goiApi<InboxList>('inbox'));
    } catch {
      // Chuông lỗi không được làm hỏng trang đang làm việc; lần sau hỏi lại.
    }
  }, [bat]);

  useEffect(() => {
    if (!bat) return;
    void tai();
    const t = setInterval(() => void tai(), NHIP_MS);
    const khiHien = () => document.visibilityState === 'visible' && void tai();
    document.addEventListener('visibilitychange', khiHien);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', khiHien);
    };
  }, [bat, tai]);

  const docMot = (id: string) => {
    setData((d) =>
      d && {
        unread: Math.max(0, d.unread - (d.items.some((x) => x.id === id && !x.readAt) ? 1 : 0)),
        items: d.items.map((x) => (x.id === id && !x.readAt ? { ...x, readAt: new Date().toISOString() } : x)),
      },
    );
    void goiApi(`inbox/${id}/read`, { method: 'POST' }).catch(() => undefined);
  };

  const docHet = async () => {
    await goiApi('inbox/read-all', { method: 'POST' }).catch(() => undefined);
    await tai();
  };

  return { data, tai, docMot, docHet };
}

export function NotificationBell({ inbox, className }: { inbox: Inbox; className?: string }) {
  const router = useRouter();
  const [mo, setMo] = useState(false);
  const chuaDoc = inbox.data?.unread ?? 0;
  const items = inbox.data?.items ?? [];

  return (
    <Popover.Root
      open={mo}
      onOpenChange={(o) => {
        setMo(o);
        if (o) void inbox.tai();
      }}
    >
      <Popover.Trigger asChild>
        <button
          type="button"
          className={`bell ${className ?? ''}`}
          aria-label={chuaDoc ? `Thông báo, ${chuaDoc} chưa đọc` : 'Thông báo'}
        >
          <Bell size={18} />
          {chuaDoc > 0 && <span className="bell-count">{chuaDoc > 99 ? '99+' : chuaDoc}</span>}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content className="popover inbox" align="end" sideOffset={8} collisionPadding={12}>
          <div className="inbox-head">
            <span className="strong">Thông báo</span>
            {chuaDoc > 0 && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void inbox.docHet()}>
                <CheckCheck size={14} /> Đọc hết
              </button>
            )}
          </div>
          {items.length === 0 ? (
            <p className="inbox-empty">
              Chưa có thông báo nào. HLV được nhắc trước giờ dạy 30 phút; lễ tân được báo khi buổi tập quá giờ chưa điểm danh.
            </p>
          ) : (
            <ul className="inbox-list">
              {items.map((n) => {
                const Icon = ICON[n.kind];
                return (
                  <li key={n.id}>
                    <button
                      type="button"
                      className="inbox-item"
                      data-unread={!n.readAt}
                      data-kind={n.kind}
                      onClick={() => {
                        inbox.docMot(n.id);
                        setMo(false);
                        if (n.link) router.push(n.link);
                      }}
                    >
                      <span className="inbox-icon" aria-hidden>
                        <Icon size={16} />
                      </span>
                      <span className="inbox-text">
                        <span className="inbox-title">{n.title}</span>
                        <span className="inbox-body">{n.body}</span>
                        <span className="inbox-time">{luc(n.createdAt)}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
