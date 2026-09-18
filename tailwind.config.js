/** @type {import('tailwindcss').Config} */
export default {
  content: ['./webapp/index.html', './webapp/src/**/*.{ts,tsx}'],
  // darkMode 已迁到 `webapp/src/tailwind.css` 的 `@custom-variant dark`
  // —— v4 不再接受 `['class', '[data-theme="dark"]']` 这种数组写法。
  theme: {
    extend: {
      colors: {
        canvas: 'var(--bg-accent)',
        panel: 'var(--panel)',
        'panel-soft': 'var(--panel-soft)',
        'panel-muted': 'var(--panel-muted)',
        line: 'var(--line)',
        'line-soft': 'var(--line-soft)',
        ink: 'var(--text)',
        muted: 'var(--muted)',
        'muted-strong': 'var(--muted-strong)',
        brand: 'var(--primary)',
        'brand-hover': 'var(--primary-hover)',
        'brand-strong': 'var(--primary-strong)',
        danger: 'var(--danger)',
      },
      boxShadow: {
        soft: 'var(--shadow-sm)',
        panel: 'var(--shadow-md)',
        elevated: 'var(--shadow-lg)',
      },
      fontFamily: {
        sans: ['Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Noto Sans SC', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
