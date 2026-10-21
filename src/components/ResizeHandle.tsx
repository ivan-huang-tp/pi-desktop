import React, { useCallback, useEffect, useRef, useState } from 'react';

interface ResizeHandleProps {
  /**
   * 拖曳時回報「相對上一次 mousemove 的位移量 (deltaX，單位 px)」。
   * 由父層決定要加到哪個面板的寬度上，並自行做邊界限制。
   */
  onResize: (deltaX: number) => void;
  /** 拖曳結束時呼叫（可用來保存狀態） */
  onResizeEnd?: () => void;
  /** 雙擊時呼叫（可用來還原預設寬度） */
  onReset?: () => void;
  /** 無障礙標籤 */
  ariaLabel?: string;
}

/**
 * 垂直分隔線：可像 VS Code 一樣按住拖曳來調整左右欄寬。
 * 平時是細線，滑鼠移過去或拖曳中會高亮顯示。
 */
export const ResizeHandle: React.FC<ResizeHandleProps> = ({
  onResize,
  onResizeEnd,
  onReset,
  ariaLabel = '調整欄位寬度',
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const lastX = useRef(0);

  // 用 ref 保存 callback，避免拖曳期間因父層 re-render 造成監聽器被重新註冊
  const onResizeRef = useRef(onResize);
  const onResizeEndRef = useRef(onResizeEnd);
  onResizeRef.current = onResize;
  onResizeEndRef.current = onResizeEnd;

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    // 只處理左鍵
    if (e.button !== 0) return;
    e.preventDefault();
    lastX.current = e.clientX;
    setIsDragging(true);
  }, []);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      const deltaX = e.clientX - lastX.current;
      if (deltaX === 0) return;
      lastX.current = e.clientX;
      onResizeRef.current(deltaX);
    };

    const stopDragging = () => {
      setIsDragging(false);
      onResizeEndRef.current?.();
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', stopDragging);

    // 拖曳期間鎖定游標與選取行為，避免選到文字或游標閃爍
    const prevCursor = document.body.style.cursor;
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', stopDragging);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevUserSelect;
    };
  }, [isDragging]);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={ariaLabel}
      title="拖曳調整寬度，雙擊還原預設"
      onMouseDown={handleMouseDown}
      onDoubleClick={onReset}
      className={`group relative z-30 w-1 shrink-0 cursor-col-resize touch-none transition-colors ${
        isDragging ? 'bg-blue-500/70' : 'bg-transparent hover:bg-blue-500/40'
      }`}
    >
      {/* 加大可點擊範圍（左右各延伸 3px），但不影響視覺上的細線 */}
      <div className="absolute inset-y-0 -left-[3px] -right-[3px]" />
    </div>
  );
};
