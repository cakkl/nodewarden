import { useEffect, useId, useMemo, useRef, useState } from 'preact/hooks';
import { filterTagSuggestions } from '@/lib/sm-tag-suggest';

/**
 * 标签输入框（带候选）。
 * ⚠️ 不用原生 `datalist`：它的下拉由**浏览器**绘制、CSS 覆盖不了；这里自建面板，复用站内下拉的
 * 类名（`.sort-menu` / `.sort-menu-item`）以沿用外观与暗色适配。
 */
export interface TagSuggestInputProps {
  label: string;
  value: string;
  /** 候选：全局标签清单（已排序）。 */
  options: string[];
  placeholder: string;
  onChange: (value: string) => void;
}

export default function TagSuggestInput(props: TagSuggestInputProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const listId = useId();
  const labelId = `${listId}-label`;
  const suggestions = useMemo(() => filterTagSuggestions(props.options, props.value), [props.options, props.value]);
  const showList = open && suggestions.length > 0;

  /** 填入候选：面板随之关闭，焦点留在输入框（便于继续改）。 */
  function pick(tag: string): void {
    props.onChange(tag);
    setOpen(false);
    setActiveIndex(-1);
  }

  // 候选变了就清掉高亮，否则高亮可能指向一个已经不在列表里的项
  useEffect(() => setActiveIndex(-1), [props.value]);

  // 点外部关闭：与站内其它下拉同一做法
  useEffect(() => {
    if (!showList) return;
    const onPointerDown = (event: Event) => {
      const target = event.target as Node | null;
      if (wrapRef.current && target && !wrapRef.current.contains(target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [showList]);

  return (
    <div className="field">
      <span id={labelId}>{props.label}</span>
      <div className="tag-suggest-wrap" ref={wrapRef}>
        <input
          className="input"
          role="combobox"
          aria-expanded={showList}
          aria-controls={showList ? listId : undefined}
          aria-autocomplete="list"
          aria-labelledby={labelId}
          aria-activedescendant={showList && activeIndex >= 0 ? `${listId}-${activeIndex}` : undefined}
          value={props.value}
          placeholder={props.placeholder}
          onFocus={() => setOpen(true)}
          onInput={(event) => {
            setOpen(true);
            props.onChange(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' && suggestions.length) {
              event.preventDefault();
              setOpen(true);
              setActiveIndex((index) => (index + 1) % suggestions.length);
            } else if (event.key === 'ArrowUp' && suggestions.length) {
              event.preventDefault();
              setActiveIndex((index) => (index <= 0 ? suggestions.length - 1 : index - 1));
            } else if (event.key === 'Enter' && suggestions[activeIndex]) {
              event.preventDefault();
              pick(suggestions[activeIndex]);
            } else if (event.key === 'Escape' || event.key === 'Tab') {
              // Escape 只收面板，不动已输入的内容
              setOpen(false);
            }
          }}
        />
        {showList && (
          <div className="sort-menu tag-suggest-menu" role="listbox" id={listId} aria-labelledby={labelId}>
            {suggestions.map((tag, index) => (
              <button
                key={tag}
                type="button"
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                className={`sort-menu-item${index === activeIndex ? ' active' : ''}`}
                // ⚠️ 必须 preventDefault：否则输入框先失焦、面板在 click 之前就被关掉
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(tag)}
              >
                <span>{tag}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
