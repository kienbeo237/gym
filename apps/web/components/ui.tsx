import Link from 'next/link';
import type { LucideIcon } from 'lucide-react';
import { ArrowLeft, Inbox, Minus, TrendingDown, TrendingUp } from 'lucide-react';
import { mauAvatar, vietTat } from '../lib/format';

/**
 * Khối giao diện dùng chung, không có state — dùng được cả trong Server
 * Component. Kiểu dáng nằm hết ở globals.css; ở đây chỉ ráp cấu trúc.
 */

export type Tone = 'success' | 'warning' | 'danger' | 'info' | 'primary' | 'neutral';

export function PageHeader({
  title,
  sub,
  actions,
  back,
}: {
  title: React.ReactNode;
  sub?: React.ReactNode;
  actions?: React.ReactNode;
  back?: { href: string; label: string };
}) {
  return (
    <>
      {back && (
        <Link href={back.href} className="back-link">
          <ArrowLeft size={15} /> {back.label}
        </Link>
      )}
      <header className="page-head">
        <div>
          <h1 className="page-title">{title}</h1>
          {sub && <p className="page-sub">{sub}</p>}
        </div>
        {actions && <div className="page-actions">{actions}</div>}
      </header>
    </>
  );
}

export function StatCard({
  label,
  value,
  unit,
  icon: Icon,
  tone,
  meta,
  trend,
}: {
  label: string;
  value: React.ReactNode;
  unit?: string;
  icon?: LucideIcon;
  tone?: Exclude<Tone, 'primary' | 'neutral'>;
  meta?: React.ReactNode;
  trend?: React.ReactNode;
}) {
  return (
    <div className="stat" data-tone={tone}>
      <div className="stat-top">
        <span className="stat-label">{label}</span>
        {Icon && (
          <span className="stat-icon">
            <Icon size={17} />
          </span>
        )}
      </div>
      <div className="stat-value">
        {value}
        {unit && <small>{unit}</small>}
      </div>
      {(trend || meta) && (
        <div className="stat-meta">
          {trend}
          {trend && meta ? ' ' : null}
          {meta}
        </div>
      )}
    </div>
  );
}

export function Trend({ dir, children }: { dir: 'up' | 'down' | 'flat'; children: React.ReactNode }) {
  const Icon = dir === 'up' ? TrendingUp : dir === 'down' ? TrendingDown : Minus;
  return (
    <span className="trend" data-dir={dir}>
      <Icon size={13} />
      {children}
    </span>
  );
}

export function Badge({
  tone = 'neutral',
  dot,
  children,
}: {
  tone?: Tone;
  dot?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span className={dot ? 'badge badge-dot' : 'badge'} data-tone={tone}>
      {children}
    </span>
  );
}

export function EmptyState({
  icon: Icon = Inbox,
  title,
  text,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  text?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon size={22} />
      </span>
      <p className="empty-title">{title}</p>
      {text && <p className="empty-text">{text}</p>}
      {action && <div className="mt-8">{action}</div>}
    </div>
  );
}

export function Avatar({ name, size }: { name: string; size?: 'sm' }) {
  return (
    <span
      className={size === 'sm' ? 'avatar avatar-sm' : 'avatar'}
      style={{ background: mauAvatar(name) }}
      aria-hidden
    >
      {vietTat(name)}
    </span>
  );
}

export function Card({
  title,
  desc,
  actions,
  children,
  flush,
  footer,
}: {
  title?: React.ReactNode;
  desc?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  /** Không đệm thân thẻ — dùng khi thân là bảng. */
  flush?: boolean;
  footer?: React.ReactNode;
}) {
  return (
    <section className="card">
      {(title || actions) && (
        <div className="card-head">
          <div>
            {title && <h2 className="card-title">{title}</h2>}
            {desc && <p className="card-desc">{desc}</p>}
          </div>
          {actions}
        </div>
      )}
      {flush ? children : <div className="card-body">{children}</div>}
      {footer && <div className="card-foot">{footer}</div>}
    </section>
  );
}

export function Alert({
  tone = 'info',
  icon: Icon,
  children,
}: {
  tone?: 'info' | 'warning' | 'danger' | 'success';
  icon: LucideIcon;
  children: React.ReactNode;
}) {
  return (
    <div className="alert" data-tone={tone} role={tone === 'danger' ? 'alert' : undefined}>
      <Icon size={17} />
      <div className="alert-body">{children}</div>
    </div>
  );
}
