export default {
  plugins: {
    // Tailwind v4：PostCSS 插件已拆到独立包。继续把 `tailwindcss` 当插件用会在
    // 构建时直接报错（"The PostCSS plugin has moved to a separate package"）。
    '@tailwindcss/postcss': {},
    // autoprefixer 已由 v4 内置（Lightning CSS）处理，不再需要单独挂载。
  },
};
