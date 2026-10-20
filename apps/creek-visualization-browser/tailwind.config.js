/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts}'],
  theme: {
    extend: {
      colors: {
        // Dev tools HUD tokens. dev-tools-hud.ts sets each `--hud-*` variable on
        // the HUD root per HUD style (Classic matches the time panel; Flight is
        // the boarding-pass look). `ink` and `accent` hold bare RGB channels so
        // opacity modifiers work; the rest carry their own alpha.
        hud: {
          ink: 'rgb(var(--hud-ink) / <alpha-value>)',
          accent: 'rgb(var(--hud-accent) / <alpha-value>)',
          panel: 'rgb(var(--hud-panel))',
          'panel-edge': 'rgb(var(--hud-panel-edge))',
          title: 'rgb(var(--hud-title))',
          label: 'rgb(var(--hud-label))',
          rule: 'rgb(var(--hud-rule))',
          'band-1': 'rgb(var(--hud-band-1))',
          'band-2': 'rgb(var(--hud-band-2))',
          'band-3': 'rgb(var(--hud-band-3))',
          well: 'rgb(var(--hud-well))',
          'well-edge': 'rgb(var(--hud-well-edge))',
          button: 'rgb(var(--hud-button))',
          'button-ink': 'rgb(var(--hud-button-ink))',
          'button-edge': 'rgb(var(--hud-button-edge))',
          'button-hover': 'rgb(var(--hud-button-hover))',
          'toggle-ink': 'rgb(var(--hud-toggle-ink))',
          'toggle-hover': 'rgb(var(--hud-toggle-hover))',
          pressed: 'rgb(var(--hud-pressed))',
          'on-pressed': 'rgb(var(--hud-on-pressed))',
          focus: 'rgb(var(--hud-focus))',
          signal: '#f3ef2a',
        },
      },
      fontFamily: {
        'hud-display': ['"Exo 2"', 'Eurostile', '"DIN Alternate"', 'ui-sans-serif', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
