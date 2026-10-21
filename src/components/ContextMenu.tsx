import React, { useEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';

export interface ContextMenuItem {
  /** 選單文字（separator 時可省略） */
  label?: string;
  icon?: React.ReactNode;
  onClick?: () => void;
  /** 紅色危險樣式（例如刪除） */
  danger?: boolean;
  disabled?: boolean;
  /** 設為 true 時渲染成一條分隔線 */
  separator?: boolean;
  /** 子選單項目（出現右側箭頭） */
  submenu?: ContextMenuItem[];
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

/** 單層選單面板（支援巢狀子選單） */
const MenuPanel: React.FC<{
  items: ContextMenuItem[];
  onClose: () => void;
  /** 深度，用於擺放方向 */
  depth?: number;
}> = ({ items, onClose, depth = 0 }) => {
  const [openIdx, setOpenIdx] = useState<number | null>(null);

  return (
    <div className="py-1">
      {items.map((item, i) => {
        if (item.separator) {
          return <div key={`sep-${i}`} className="my-1 h-px bg-zinc-700/60" />;
        }
        const hasSub = !!(item.submenu && item.submenu.length > 0);
        return (
          <div
            key={`${item.label}-${i}`}
            className="relative"
            onMouseEnter={() => setOpenIdx(hasSub ? i : null)}
          >
            <button
              type="button"
              disabled={item.disabled}
              onClick={() => {
                if (hasSub || item.disabled) return;
                try {
                  item.onClick?.();
                } finally {
                  onClose();
                }
              }}
              className={`w-full flex items-center gap-3 px-3 py-[7px] text-sm transition-colors text-left ${
                item.disabled
                  ? 'text-zinc-600 cursor-default'
                  : item.danger
                  ? 'text-red-400 hover:bg-red-500/10 hover:text-red-300'
                  : 'text-zinc-200 hover:bg-zinc-700/60'
              }`}
            >
              <span className={`w-4 h-4 shrink-0 flex items-center justify-center ${item.danger ? 'text-red-400' : 'text-zinc-400'}`}>
                {item.icon}
              </span>
              <span className="flex-1 truncate">{item.label}</span>
              {hasSub && <ChevronRight size={13} className="text-zinc-500 shrink-0" />}
            </button>

            {hasSub && openIdx === i && (
              <div
                className={`absolute top-[-4px] ${
                  depth === 0 ? 'left-full ml-0.5' : 'right-full mr-0.5'
                } min-w-[170px] rounded-lg border border-[#3f3f46] bg-[#1f1f23] shadow-2xl shadow-black/50 z-50`}
              >
                <MenuPanel items={item.submenu!} onClose={onClose} depth={depth + 1} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};

/**
 * 自製右鍵選單（深色主題，與 App 樣式一致）
 * - 全螢幕透明遮罩：點擊任意處 / 右鍵 / Escape 皆可關閉
 * - 自動避開視窗邊界
 */
export const ContextMenu: React.FC<ContextMenuProps> = ({ x, y, items, onClose }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });

  // 自動避開視窗邊界
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let nx = x;
    let ny = y;
    if (x + rect.width > window.innerWidth - 8) nx = Math.max(8, window.innerWidth - rect.width - 8);
    if (y + rect.height > window.innerHeight - 8) ny = Math.max(8, window.innerHeight - rect.height - 8);
    setPos({ x: nx, y: ny });
  }, [x, y, items]);

  // Escape 關閉 + 視窗縮放/滾動時關閉
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onScrollOrResize = () => onClose();
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onScrollOrResize);
    window.addEventListener('wheel', onScrollOrResize, { passive: true });
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onScrollOrResize);
      window.removeEventListener('wheel', onScrollOrResize);
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[1000]"
      onMouseDown={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div
        ref={ref}
        style={{ left: pos.x, top: pos.y }}
        className="fixed min-w-[190px] rounded-lg border border-[#3f3f46] bg-[#1f1f23] shadow-2xl shadow-black/50 text-zinc-200"
        onMouseDown={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
      >
        <MenuPanel items={items} onClose={onClose} />
      </div>
    </div>
  );
};
