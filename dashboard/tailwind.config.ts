import type { Config } from 'tailwindcss';

const config: Config = {
  content: ['./app/**/*.{js,ts,jsx,tsx,mdx}', './components/**/*.{js,ts,jsx,tsx,mdx}'],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: '#0a0a0a',
          deep: '#0a0a0a',
          surface: '#111111',
          panel: '#171717',
        },
        border: {
          DEFAULT: '#262626',
          subtle: '#1f1f1f',
        },
        ink: {
          DEFAULT: '#e5e5e5',
          muted: '#a3a3a3',
          dim: '#737373',
        },
        accent: {
          orange: '#ff7a00',
          green: '#10b981',
          red: '#ef4444',
          blue: '#3b82f6',
        },
      },
      fontFamily: {
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'monospace'],
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        serif: ['var(--font-serif)', 'ui-serif', 'Georgia', 'serif'],
      },
      fontSize: {
        base: ['14px', { lineHeight: '1.5' }],
      },
    },
  },
  plugins: [],
};

export default config;
