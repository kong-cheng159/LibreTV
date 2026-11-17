'use client';

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { cn } from '@/lib/utils';
import { Icon } from './icon';

export interface DropdownOption {
  value: string;
  label: string;
  /** 选项面板内的次要说明（弱色小字，第二行），便于对比着选 */
  hint?: string;
}

/**
 * 自定义下拉：替代原生 <select>——原生展开面板由操作系统渲染，
 * 与站点风格割裂、暗色模式下尤其突兀。面板为浮层卡片（surface-raised + 阴影 +
 * fade-in），选中项带勾号；支持点击外部 / Esc 关闭与 ↑ ↓ Enter 键盘导航。
 * 可选 searchable：面板顶部检索框，按名称 / hint 过滤。
 */
export function Dropdown({
  value,
  onChange,
  options,
  ariaLabel,
  className,
  searchable = false,
  searchPlaceholder = '搜索…',
}: {
  value: string;
  onChange: (v: string) => void;
  options: DropdownOption[];
  ariaLabel: string;
  className?: string;
  /** 选项很多时在面板内提供检索 */
  searchable?: boolean;
  searchPlaceholder?: string;
}) {
  const [open, setOpen] = useState(false);
  /** 键盘 / 悬停高亮项下标（相对 filtered）；-1 表示无高亮 */
  const [active, setActive] = useState(-1);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selected = options.find((o) => o.value === value);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        (o.hint ? o.hint.toLowerCase().includes(q) : false) ||
        o.value.toLowerCase().includes(q)
    );
  }, [options, query]);

  // 展开期间监听外部点击收起
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // 仅在「打开瞬间」重置检索与高亮；不依赖 options 引用，避免父组件每次渲染把输入清掉
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(-1);
    if (searchable) {
      const t = window.setTimeout(() => searchRef.current?.focus(), 0);
      return () => window.clearTimeout(t);
    }
  }, [open, searchable]);

  // 过滤结果 / 打开后：校正高亮到合法下标（优先当前选中项）
  useEffect(() => {
    if (!open) return;
    if (filtered.length === 0) {
      setActive(-1);
      return;
    }
    setActive((i) => {
      if (i >= 0 && i < filtered.length) return i;
      const sel = filtered.findIndex((o) => o.value === value);
      return sel >= 0 ? sel : 0;
    });
  }, [filtered, open, value]);

  const toggle = () => {
    setOpen((v) => !v);
  };

  const pick = (v: string) => {
    onChange(v);
    setOpen(false);
  };

  const moveActive = (dir: 1 | -1) => {
    if (filtered.length === 0) return;
    setActive((i) => (Math.max(i, 0) + dir + filtered.length) % filtered.length);
  };

  const onTriggerKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        setOpen(false);
        break;
      case 'ArrowDown':
        e.preventDefault();
        moveActive(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        moveActive(-1);
        break;
      case 'Enter': {
        e.preventDefault();
        const opt = filtered[active];
        if (opt) pick(opt.value);
        break;
      }
    }
  };

  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'Escape':
        e.preventDefault();
        setOpen(false);
        break;
      case 'ArrowDown':
        e.preventDefault();
        moveActive(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        moveActive(-1);
        break;
      case 'Enter': {
        e.preventDefault();
        const opt = filtered[active];
        if (opt) pick(opt.value);
        break;
      }
    }
  };

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={toggle}
        onKeyDown={onTriggerKeyDown}
        className={cn(
          'input flex w-full items-center justify-between gap-1.5 cursor-pointer text-left',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:border-accent',
          open && 'border-accent'
        )}
      >
        <span className="truncate">{selected?.label ?? value}</span>
        <Icon
          name="chevronDown"
          className={cn(
            'w-3.5 h-3.5 shrink-0 text-faint transition-transform duration-200',
            open && 'rotate-180 text-accent'
          )}
        />
      </button>
      {open && (
        <div
          className={cn(
            'absolute left-0 top-full z-50 mt-1.5 min-w-full w-max max-h-72 flex flex-col',
            'max-w-[min(36rem,calc(100vw-2rem))]',
            'rounded-xl border border-line bg-surface-raised shadow-xl animate-fade-in overflow-hidden'
          )}
        >
          {searchable && (
            <div className="shrink-0 border-b border-line/70 p-1.5">
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onSearchKeyDown}
                placeholder={searchPlaceholder}
                aria-label={`${ariaLabel}检索`}
                className="input w-full !py-1.5 text-xs"
                // 避免 mousedown 被外部关闭逻辑误伤前，先停在输入框内
                onMouseDown={(e) => e.stopPropagation()}
              />
            </div>
          )}
          <ul role="listbox" aria-label={ariaLabel} className="min-h-0 flex-1 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-xs text-faint">无匹配项</li>
            ) : (
              filtered.map((o, i) => {
                const isSelected = o.value === value;
                return (
                  <li key={o.value}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      onMouseEnter={() => setActive(i)}
                      onClick={() => pick(o.value)}
                      className={cn(
                        'flex w-full items-center gap-2 px-3 py-1.5 text-left transition-colors',
                        i === active && 'bg-hover'
                      )}
                    >
                      <span className="min-w-0 flex-1">
                        <span
                          className={cn(
                            'block whitespace-nowrap truncate text-xs',
                            isSelected ? 'text-accent font-medium' : 'text-content'
                          )}
                        >
                          {o.label}
                        </span>
                        {o.hint && (
                          <span className="block truncate whitespace-nowrap text-[11px] text-faint">{o.hint}</span>
                        )}
                      </span>
                      {isSelected && <Icon name="check" className="ml-auto w-3.5 h-3.5 shrink-0 text-accent" />}
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </div>
      )}
    </div>
  );
}
