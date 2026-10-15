/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts}'],
  theme: {
    extend: {
      colors: {
        // Dev tools HUD palette: ice-blue boarding-pass panel, dark ink, signal yellow.
        hud: {
          ice: '#d4e9ed',
          frost: '#c1dbe1',
          ink: '#16242a',
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
