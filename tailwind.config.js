/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      // 統一字級比例：取代原本散落的 text-[10px]/[11px]/[11.5px]/[12px]。
      // 整體較原本放大約 1px，且越小的字放大越多，維持一致的視覺比例。
      fontSize: {
        '2xs': ['0.75rem', { lineHeight: '1.35' }], // 12px（原本 10~11.5px 的微標籤）
        xs: ['0.8125rem', { lineHeight: '1.4' }], // 13px（原本 12px 的內文主力）
        sm: ['0.9375rem', { lineHeight: '1.5' }], // 15px（原本 14px 的重點/對話）
        base: ['1.0625rem', { lineHeight: '1.55' }], // 17px（標題）
        lg: ['1.1875rem', { lineHeight: '1.55' }], // 19px
      },
      colors: {
        sidebar: {
          bg: '#18181b', // 類似 Antigravity 的深灰色
          hover: '#27272a',
          active: '#3f3f46',
          border: '#27272a',
          text: '#a1a1aa',
          textHover: '#f4f4f5',
        },
        chat: {
          bg: '#121214',
          bubbleUser: '#27272a',
          bubbleAssistant: '#18181b',
          border: '#27272a',
        },
        panel: {
          bg: '#18181b',
          header: '#1f1f23',
          border: '#27272a',
        }
      }
    },
  },
  plugins: [],
}
