import { useEffect, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { Check, ChevronDown } from 'lucide-preact';

/**
 * 列表页在手机 / 中间态（≤1180px）使用的筛选下拉。
 * 复用 `VaultListPanel` 的 DOM 结构与类名（`.mobile-vault-filter-*` / `.sort-menu*`），
 * 外观与暗色适配直接沿用 `vault.css` / `dark.css`；展开状态由组件自己管理。
 */
export interface MobileFilterOption {
  value: string;
  label: string;
  icon: ComponentChildren;
  active: boolean;
  onSelect: () => void;
}

interface MobileFilterMenuProps {
  /** 未选中任何项时显示的占位文案（通常是分类名，如「类型」）。 */
  label: string;
  selected?: MobileFilterOption;
  fallbackIcon: ComponentChildren;
  options: MobileFilterOption[];
}

export default function MobileFilterMenu(props: MobileFilterMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // 点外部关闭：只作用于本菜单，避免多个筛选同时展开。
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: Event) => {
      const target = event.target as Node | null;
      if (wrapRef.current && target && !wrapRef.current.contains(target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  return (
    <div className="mobile-vault-filter-control" ref={wrapRef}>
      <button
        type="button"
        className={`mobile-vault-filter-trigger ${open ? 'active' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="mobile-vault-filter-trigger-icon">{props.selected?.icon || props.fallbackIcon}</span>
        <span className="mobile-vault-filter-trigger-label">{props.selected?.label || props.label}</span>
        <ChevronDown size={13} className="mobile-vault-filter-chevron" />
      </button>
      {open && (
        <div className="sort-menu mobile-vault-filter-menu" role="menu">
          {props.options.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`sort-menu-item mobile-vault-filter-item ${option.active ? 'active' : ''}`}
              role="menuitemradio"
              aria-checked={option.active}
              onClick={() => {
                option.onSelect();
                setOpen(false);
              }}
            >
              <span className="mobile-vault-filter-item-main">
                <span className="mobile-vault-filter-item-icon">{option.icon}</span>
                <span>{option.label}</span>
              </span>
              {option.active ? <Check size={14} /> : <span className="sort-menu-check-placeholder" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
